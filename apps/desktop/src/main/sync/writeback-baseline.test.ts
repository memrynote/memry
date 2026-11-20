import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { getNoteCacheById, insertNoteCache, updateNoteCache } from '@main/database/queries/notes'
import { generateContentHash } from '../vault/frontmatter'
import { isOutsideEdit, writeWithBaseline } from './writeback-baseline'

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
