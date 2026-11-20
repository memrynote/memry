import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { getNoteCacheById, insertNoteCache, updateNoteCache } from '@main/database/queries/notes'
import { generateContentHash } from '../vault/frontmatter'
import {
  baselineAfterWrite,
  baselineBeforeFeed,
  isOutsideEdit,
  landBodyEdit,
  writeWithBaseline
} from './writeback-baseline'

const A = '# Log\n\nFirst line.\n'
const B = '# Log\n\nFirst line. Second.\n'
const row = {
  id: 'n1',
  path: 'a.md',
  title: 'a',
  fileType: 'markdown' as const,
  createdAt: '2026-01-01T00:00:00.000Z',
  modifiedAt: '2026-01-01T00:00:00.000Z'
}

/**
 * A write-back that crashed after its file write leaves the bytes it wrote as
 * its pending hash. A cache write that keeps the hash it found must keep that
 * record, or recovery reads Memry's own bytes as an outside edit (#5296 I2a).
 */
describe('the write-ahead record of a crashed write-back', () => {
  let index: TestDatabaseResult
  beforeEach(() => {
    index = createTestIndexDb()
    insertNoteCache(index.db, { ...row, contentHash: generateContentHash(A) })
  })
  afterEach(() => index.close())
  const cached = () => getNoteCacheById(index.db, 'n1')!

  async function crashAfterWrite(during: () => void): Promise<void> {
    await writeWithBaseline(index.db, 'n1', B, async () => {
      during()
      throw new Error('crash after the file write')
    }).catch(() => {})
  }

  it('survives a projection of the same hash that lands during the write', async () => {
    await crashAfterWrite(() =>
      updateNoteCache(index.db, 'n1', { contentHash: generateContentHash(A), title: 'a' })
    )
    expect(cached().pendingWriteHash).toBe(generateContentHash(B))
    expect(isOutsideEdit(index.db, 'n1', cached(), B)).toBe(false)
  })

  it('survives a re-upsert that keeps the same hash after the crash', async () => {
    await crashAfterWrite(() => {})
    insertNoteCache(index.db, { ...row, contentHash: generateContentHash(A) })
    expect(isOutsideEdit(index.db, 'n1', cached(), B)).toBe(false)
  })
})

describe('the clear rule of the pending hash', () => {
  let index: TestDatabaseResult
  beforeEach(() => {
    index = createTestIndexDb()
  })
  afterEach(() => index.close())
  const pending = () => getNoteCacheById(index.db, 'n1')!.pendingWriteHash

  it('keeps a pending hash when a NULL hash is written over NULL', () => {
    insertNoteCache(index.db, { ...row, contentHash: null })
    updateNoteCache(index.db, 'n1', { pendingWriteHash: 'p' })
    updateNoteCache(index.db, 'n1', { contentHash: null, title: 'b' })
    insertNoteCache(index.db, { ...row, contentHash: null })
    expect(pending()).toBe('p')
  })

  it('keeps a pending hash when a write omits the hash', () => {
    insertNoteCache(index.db, { ...row, contentHash: generateContentHash(A) })
    updateNoteCache(index.db, 'n1', { pendingWriteHash: 'p' })
    updateNoteCache(index.db, 'n1', { contentHash: undefined, title: 'b' })
    insertNoteCache(index.db, { ...row })
    expect(pending()).toBe('p')
    expect(getNoteCacheById(index.db, 'n1')!.contentHash).toBe(generateContentHash(A))
  })
})

/**
 * Memry's own body edit lands in the doc first, then in the file through
 * `writeWithBaseline` (D-DOC-FIRST, #5304). A doc that does not take the edit
 * still gets the file written, with the baseline kept, so the write-back reads
 * the file as an outside edit and feeds it at open.
 */
describe("Memry's own body edit (landBodyEdit)", () => {
  let index: TestDatabaseResult
  let disk: string
  beforeEach(() => {
    index = createTestIndexDb()
    insertNoteCache(index.db, { ...row, contentHash: generateContentHash(A) })
    disk = A
  })
  afterEach(() => index.close())
  const cached = () => getNoteCacheById(index.db, 'n1')!
  const write = async (): Promise<void> => {
    disk = B
  }

  it('publishes the baseline it finds for bytes the doc does not hold', () => {
    expect(baselineBeforeFeed(index.db, 'n1', B)).toBe(generateContentHash(A))
  })

  it('writes the file and records it once the doc took the edit', async () => {
    const order: string[] = []
    const published = await landBodyEdit(index.db, 'n1', B, {
      feed: async () => (order.push('feed'), true),
      write: async () => (order.push('write'), write())
    })
    expect(order).toEqual(['feed', 'write'])
    expect(disk).toBe(B)
    expect(published).toBe(generateContentHash(B))
    expect(isOutsideEdit(index.db, 'n1', cached(), B)).toBe(false)
  })

  it('writes the file and keeps the baseline when the doc declines', async () => {
    const published = await landBodyEdit(index.db, 'n1', B, { feed: async () => false, write })
    expect(disk).toBe(B)
    expect(published).toBe(generateContentHash(A))
    expect(isOutsideEdit(index.db, 'n1', cached(), B)).toBe(true)
  })

  it('writes the file and keeps the baseline when the feed throws', async () => {
    const published = await landBodyEdit(index.db, 'n1', B, {
      feed: async () => {
        throw new Error('store failed')
      },
      write
    })
    expect(disk).toBe(B)
    expect(published).toBe(generateContentHash(A))
    expect(isOutsideEdit(index.db, 'n1', cached(), B)).toBe(true)
  })

  // A crash between the file write and the record: the pending hash names the
  // bytes, so recovery reads them as Memry's own.
  it('leaves its bytes its own when the process stops after the write', async () => {
    await landBodyEdit(index.db, 'n1', B, {
      feed: async () => true,
      write: async () => {
        disk = B
        throw new Error('crash after the file write')
      }
    }).catch(() => {})
    expect(cached().contentHash).toBe(generateContentHash(A))
    expect(isOutsideEdit(index.db, 'n1', cached(), disk)).toBe(false)
  })
})

describe('a writer that does not feed the doc', () => {
  let index: TestDatabaseResult
  beforeEach(() => {
    index = createTestIndexDb()
    insertNoteCache(index.db, { ...row, contentHash: generateContentHash(A) })
  })
  afterEach(() => index.close())

  it('moves the baseline for a frontmatter edit of the baseline', () => {
    const edited = `---\ntags: [x]\n---\n${A}`
    expect(baselineAfterWrite(index.db, 'n1', A, edited)).toBe(generateContentHash(edited))
  })

  it('keeps the baseline under a frontmatter edit of an outside edit', () => {
    const edited = `---\ntags: [x]\n---\n${B}`
    expect(baselineAfterWrite(index.db, 'n1', B, edited)).toBe(generateContentHash(A))
  })
})
