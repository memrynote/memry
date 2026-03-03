import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TestDatabaseResult, TestDb } from '@tests/utils/test-db'
import { createTestIndexDb, sql } from '@tests/utils/test-db'
import { createFtsTable, insertFtsNote } from './fts'
import {
  queueFtsUpdate,
  flushFtsUpdates,
  cancelPendingFtsUpdates,
  getPendingFtsCount,
  hasPendingFtsUpdates,
  scheduleFlush
} from './fts-queue'

const mockFtsWarn = vi.hoisted(() => vi.fn())

// Mock getIndexDatabase for automatic timer flush tests
vi.mock('./client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./client')>()
  return {
    ...actual,
    getIndexDatabase: vi.fn()
  }
})

vi.mock('../lib/logger', () => ({
  createLogger: vi.fn(() => ({
    warn: mockFtsWarn
  }))
}))

import { getIndexDatabase } from './client'

describe('fts-queue', () => {
  let dbResult: TestDatabaseResult
  let db: TestDb

  beforeEach(() => {
    vi.useFakeTimers()
    dbResult = createTestIndexDb()
    db = dbResult.db
    createFtsTable(db)

    // Reset queue state before each test
    cancelPendingFtsUpdates()

    // Setup mock to return test db
    vi.mocked(getIndexDatabase).mockReturnValue(db)
    mockFtsWarn.mockClear()
  })

  afterEach(() => {
    cancelPendingFtsUpdates()
    vi.useRealTimers()
    vi.clearAllMocks()
    dbResult.close()
  })

  describe('queueFtsUpdate', () => {
    it('adds update to pending queue', () => {
      expect(hasPendingFtsUpdates()).toBe(false)
      expect(getPendingFtsCount()).toBe(0)

      queueFtsUpdate('note-1', 'content', ['tag1'])

      expect(hasPendingFtsUpdates()).toBe(true)
      expect(getPendingFtsCount()).toBe(1)
    })

    it('deduplicates updates by noteId (latest wins)', () => {
      queueFtsUpdate('note-1', 'old content', ['old-tag'])
      queueFtsUpdate('note-1', 'new content', ['new-tag'])

      expect(getPendingFtsCount()).toBe(1)

      // Flush and verify the latest content was used
      insertFtsNote(db, 'note-1', 'Test Note', '', [])
      const count = flushFtsUpdates(db)

      expect(count).toBe(1)

      const result = db.get<{ content: string; tags: string }>(sql`
        SELECT content, tags FROM fts_notes WHERE id = 'note-1'
      `)
      expect(result?.content).toBe('new content')
      expect(result?.tags).toBe('new-tag')
    })

    it('queues multiple different notes', () => {
      queueFtsUpdate('note-1', 'content 1', ['tag1'])
      queueFtsUpdate('note-2', 'content 2', ['tag2'])
      queueFtsUpdate('note-3', 'content 3', ['tag3'])

      expect(getPendingFtsCount()).toBe(3)
    })
  })

  describe('flushFtsUpdates', () => {
    it('processes all pending updates', () => {
      // Insert FTS entries first (normally done via trigger)
      insertFtsNote(db, 'note-1', 'Note 1', '', [])
      insertFtsNote(db, 'note-2', 'Note 2', '', [])

      queueFtsUpdate('note-1', 'updated content 1', ['tag1', 'tag2'])
      queueFtsUpdate('note-2', 'updated content 2', ['tag3'])

      const count = flushFtsUpdates(db)

      expect(count).toBe(2)
      expect(hasPendingFtsUpdates()).toBe(false)

      // Verify updates were applied
      const note1 = db.get<{ content: string; tags: string }>(sql`
        SELECT content, tags FROM fts_notes WHERE id = 'note-1'
      `)
      expect(note1?.content).toBe('updated content 1')
      expect(note1?.tags).toBe('tag1 tag2')

      const note2 = db.get<{ content: string; tags: string }>(sql`
        SELECT content, tags FROM fts_notes WHERE id = 'note-2'
      `)
      expect(note2?.content).toBe('updated content 2')
      expect(note2?.tags).toBe('tag3')
    })

    it('returns 0 when queue is empty', () => {
      expect(flushFtsUpdates(db)).toBe(0)
    })

    it('clears queue after processing', () => {
      insertFtsNote(db, 'note-1', 'Note 1', '', [])
      queueFtsUpdate('note-1', 'content', ['tag'])

      expect(getPendingFtsCount()).toBe(1)
      flushFtsUpdates(db)
      expect(getPendingFtsCount()).toBe(0)
    })

    it('cancels pending timer when called', () => {
      queueFtsUpdate('note-1', 'content', ['tag'])

      // Timer should be scheduled
      insertFtsNote(db, 'note-1', 'Note 1', '', [])
      flushFtsUpdates(db)

      // Advance time past the delay - should not trigger another flush
      vi.advanceTimersByTime(3000)

      // Queue should still be empty (no double flush)
      expect(getPendingFtsCount()).toBe(0)
    })
  })

  describe('cancelPendingFtsUpdates', () => {
    it('clears queue without processing', () => {
      insertFtsNote(db, 'note-1', 'Note 1', 'original', [])
      queueFtsUpdate('note-1', 'new content', ['tag'])

      expect(getPendingFtsCount()).toBe(1)
      cancelPendingFtsUpdates()
      expect(getPendingFtsCount()).toBe(0)

      // Verify content was NOT updated
      const result = db.get<{ content: string }>(sql`
        SELECT content FROM fts_notes WHERE id = 'note-1'
      `)
      expect(result?.content).toBe('original')
    })

    it('cancels pending timer', () => {
      queueFtsUpdate('note-1', 'content', ['tag'])
      cancelPendingFtsUpdates()

      // Advance time - should not cause any issues
      vi.advanceTimersByTime(3000)
      expect(getPendingFtsCount()).toBe(0)
    })
  })

  describe('automatic timer flush', () => {
    it('flushes queue after 2000ms delay', () => {
      insertFtsNote(db, 'note-1', 'Note 1', '', [])
      queueFtsUpdate('note-1', 'auto flushed content', ['auto-tag'])

      expect(getPendingFtsCount()).toBe(1)

      // Advance time just before the delay
      vi.advanceTimersByTime(1999)
      expect(getPendingFtsCount()).toBe(1)

      // Advance past the delay
      vi.advanceTimersByTime(1)
      expect(getPendingFtsCount()).toBe(0)

      // Verify content was updated
      const result = db.get<{ content: string; tags: string }>(sql`
        SELECT content, tags FROM fts_notes WHERE id = 'note-1'
      `)
      expect(result?.content).toBe('auto flushed content')
      expect(result?.tags).toBe('auto-tag')
    })

    it('only schedules one timer for multiple rapid updates', () => {
      insertFtsNote(db, 'note-1', 'Note 1', '', [])
      insertFtsNote(db, 'note-2', 'Note 2', '', [])

      queueFtsUpdate('note-1', 'content 1', ['tag1'])
      vi.advanceTimersByTime(500)
      queueFtsUpdate('note-2', 'content 2', ['tag2'])
      vi.advanceTimersByTime(500)
      queueFtsUpdate('note-1', 'content 1 updated', ['tag1-updated'])

      // Still 1500ms until original timer fires
      expect(getPendingFtsCount()).toBe(2)

      vi.advanceTimersByTime(1000)
      // Timer fires, all updates processed
      expect(getPendingFtsCount()).toBe(0)

      const note1 = db.get<{ content: string }>(sql`
        SELECT content FROM fts_notes WHERE id = 'note-1'
      `)
      expect(note1?.content).toBe('content 1 updated')
    })

    it('handles database not being open gracefully', () => {
      vi.mocked(getIndexDatabase).mockImplementation(() => {
        throw new Error('Database not open')
      })

      queueFtsUpdate('note-1', 'content', ['tag'])
      vi.advanceTimersByTime(2000)

      // Should log warning but not throw
      expect(mockFtsWarn).toHaveBeenCalledWith('Failed to flush updates:', expect.any(Error))
    })
  })

  describe('scheduleFlush', () => {
    it('schedules flush with custom delay', () => {
      insertFtsNote(db, 'note-1', 'Note 1', '', [])
      queueFtsUpdate('note-1', 'content', ['tag'])

      scheduleFlush(db, 500)

      vi.advanceTimersByTime(499)
      expect(getPendingFtsCount()).toBe(1)

      vi.advanceTimersByTime(1)
      expect(getPendingFtsCount()).toBe(0)
    })

    it('replaces existing timer', () => {
      insertFtsNote(db, 'note-1', 'Note 1', '', [])
      queueFtsUpdate('note-1', 'content', ['tag'])

      // Original timer would fire at 2000ms
      vi.advanceTimersByTime(1000)

      // Schedule new flush at 500ms from now
      scheduleFlush(db, 500)

      vi.advanceTimersByTime(500)
      expect(getPendingFtsCount()).toBe(0)
    })
  })

  describe('getPendingFtsCount and hasPendingFtsUpdates', () => {
    it('returns correct values', () => {
      expect(getPendingFtsCount()).toBe(0)
      expect(hasPendingFtsUpdates()).toBe(false)

      queueFtsUpdate('note-1', 'content', ['tag'])
      expect(getPendingFtsCount()).toBe(1)
      expect(hasPendingFtsUpdates()).toBe(true)

      queueFtsUpdate('note-2', 'content', ['tag'])
      expect(getPendingFtsCount()).toBe(2)
      expect(hasPendingFtsUpdates()).toBe(true)

      cancelPendingFtsUpdates()
      expect(getPendingFtsCount()).toBe(0)
      expect(hasPendingFtsUpdates()).toBe(false)
    })
  })
})
