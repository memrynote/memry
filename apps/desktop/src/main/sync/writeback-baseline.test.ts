import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { getNoteCacheById, insertNoteCache, updateNoteCache } from '@main/database/queries/notes'
import { generateContentHash } from '../vault/frontmatter'
import {
  baselineAfterWrite,
  baselineBeforeFeed,
  feedThenRecordBaseline,
  isOutsideEdit,
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

/** A Memry writer that feeds its bytes to the doc after writing them (#5304). */
describe("a writer's bytes become the baseline only once the doc holds them", () => {
  let index: TestDatabaseResult
  beforeEach(() => {
    index = createTestIndexDb()
    insertNoteCache(index.db, { ...row, contentHash: generateContentHash(A) })
  })
  afterEach(() => index.close())
  const cached = () => getNoteCacheById(index.db, 'n1')!

  it('publishes the baseline it finds before the feed', () => {
    expect(baselineBeforeFeed(index.db, 'n1', B)).toBe(generateContentHash(A))
  })

  it('records the bytes once the doc took them', async () => {
    await feedThenRecordBaseline(index.db, 'n1', B, async () => true)
    expect(isOutsideEdit(index.db, 'n1', cached(), B)).toBe(false)
  })

  it('keeps the baseline when the doc did not take them', async () => {
    await feedThenRecordBaseline(index.db, 'n1', B, async () => false)
    expect(isOutsideEdit(index.db, 'n1', cached(), B)).toBe(true)
  })

  it('leaves a baseline a write-back moved during the feed', async () => {
    const C = '# Log\n\nThird.\n'
    await feedThenRecordBaseline(index.db, 'n1', B, async () => {
      updateNoteCache(index.db, 'n1', { contentHash: generateContentHash(C) })
      return true
    })
    expect(cached().contentHash).toBe(generateContentHash(C))
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
