import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { getNoteCacheById, insertNoteCache, updateNoteCache } from './note-crud'

/**
 * A hash moved outside the write-back supersedes the write it had pending, so
 * a stale pending hash never reads a later file as Memry's own
 * (sync/writeback-baseline.ts).
 */
describe('note_cache pending_write_hash', () => {
  let index: TestDatabaseResult
  const row = {
    id: 'n1',
    path: 'a.md',
    title: 'a',
    fileType: 'markdown' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
    modifiedAt: '2026-01-01T00:00:00.000Z'
  }

  beforeEach(() => {
    index = createTestIndexDb()
    insertNoteCache(index.db, { ...row, contentHash: 'A' })
    updateNoteCache(index.db, 'n1', { pendingWriteHash: 'B' })
  })

  afterEach(() => index.close())

  const stored = () => {
    const cached = getNoteCacheById(index.db, 'n1')
    return { contentHash: cached?.contentHash, pendingWriteHash: cached?.pendingWriteHash }
  }

  it('clears a pending write when an upsert moves the hash', () => {
    insertNoteCache(index.db, { ...row, contentHash: 'C' })
    expect(stored()).toEqual({ contentHash: 'C', pendingWriteHash: null })
  })

  it('clears a pending write when an update moves the hash', () => {
    updateNoteCache(index.db, 'n1', { contentHash: 'C' })
    expect(stored()).toEqual({ contentHash: 'C', pendingWriteHash: null })
  })

  it('keeps a pending write through an update that leaves the hash alone', () => {
    updateNoteCache(index.db, 'n1', { title: 'renamed' })
    expect(stored()).toEqual({ contentHash: 'A', pendingWriteHash: 'B' })
  })
})
