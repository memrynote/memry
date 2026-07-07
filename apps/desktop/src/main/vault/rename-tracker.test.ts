import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { NotesChannels } from '@memry/contracts/ipc-channels'
import { noteCache } from '@memry/db-schema/schema/notes-cache'
import { createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { MockBrowserWindow } from '@tests/utils/mock-electron'
import { BrowserWindow } from 'electron'

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn()
  }
}))

vi.mock('../database', () => ({
  getIndexDatabase: vi.fn(),
  getDatabase: vi.fn()
}))

vi.mock('@memry/storage-data', () => ({
  updateNoteMetadata: vi.fn()
}))

import { getDatabase, getIndexDatabase } from '../database'
import {
  trackPendingDelete,
  checkForRename,
  processRename,
  clearPendingDelete,
  clearAllPendingDeletes,
  hasPendingDeletes,
  getPendingDeleteCount
} from './rename-tracker'

describe('rename-tracker', () => {
  let indexDb: TestDatabaseResult
  let window: MockBrowserWindow

  beforeEach(() => {
    indexDb = createTestIndexDb()
    vi.mocked(getIndexDatabase).mockReturnValue(indexDb.db)
    vi.mocked(getDatabase).mockReturnValue({} as ReturnType<typeof getDatabase>)

    window = new MockBrowserWindow()
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([window as never])
  })

  afterEach(() => {
    clearAllPendingDeletes()
    indexDb.close()
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  // ==========================================================================
  // T596: trackPendingDelete timeout triggers onRealDelete
  // ==========================================================================
  it('triggers onRealDelete when no rename occurs', async () => {
    vi.useFakeTimers()
    const onRealDelete = vi.fn().mockResolvedValue(undefined)

    trackPendingDelete('note-1', 'hash-1', 'notes/old.md', onRealDelete)

    expect(hasPendingDeletes()).toBe(true)
    expect(getPendingDeleteCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(500)

    expect(onRealDelete).toHaveBeenCalledTimes(1)
    expect(hasPendingDeletes()).toBe(false)
  })

  // ==========================================================================
  // T597: checkForRename reports rename without mutating cache inline
  // ==========================================================================
  it('matches by content hash and leaves cache updates to the caller', async () => {
    const now = new Date().toISOString()
    indexDb.db
      .insert(noteCache)
      .values({
        id: 'note-2',
        path: 'notes/old-name.md',
        title: 'old-name',
        contentHash: 'hash',
        wordCount: 0,
        characterCount: 0,
        createdAt: now,
        modifiedAt: now
      })
      .run()

    trackPendingDelete('note-2', 'hash', 'notes/old-name.md', vi.fn())

    const match = checkForRename('hash', 'notes/new-name.md')

    expect(match).toEqual({ id: 'note-2', oldPath: 'notes/old-name.md' })

    const unchanged = indexDb.db.select().from(noteCache).where(eq(noteCache.id, 'note-2')).get()

    expect(unchanged?.path).toBe('notes/old-name.md')
    expect(unchanged?.title).toBe('old-name')
    expect(window.webContents.send).not.toHaveBeenCalled()
  })

  it('returns null when no pending delete matches the hash', () => {
    trackPendingDelete('note-x', 'hash-x', 'notes/x.md', vi.fn())
    expect(checkForRename('other-hash', 'notes/new.md')).toBeNull()
    clearPendingDelete('note-x')
  })

  it('refuses to disambiguate identical-hash collisions (no identity swap)', async () => {
    vi.useFakeTimers()
    const onRealDeleteA = vi.fn().mockResolvedValue(undefined)
    const onRealDeleteB = vi.fn().mockResolvedValue(undefined)

    trackPendingDelete('note-a', 'same-hash', 'notes/a.md', onRealDeleteA)
    trackPendingDelete('note-b', 'same-hash', 'notes/b.md', onRealDeleteB)
    expect(getPendingDeleteCount()).toBe(2)

    // Ambiguous identical-content collision: never adopt an identity — a FIFO
    // guess could attach a deleted note's history to the wrong surviving file.
    expect(checkForRename('same-hash', 'notes/a-renamed.md')).toBeNull()
    expect(getPendingDeleteCount()).toBe(2)

    // Both pending deletes fall through and resolve as genuine deletes.
    await vi.advanceTimersByTimeAsync(500)
    expect(onRealDeleteA).toHaveBeenCalledTimes(1)
    expect(onRealDeleteB).toHaveBeenCalledTimes(1)
  })

  it('matches a single pending delete of a given hash as a rename', () => {
    const onRealDelete = vi.fn().mockResolvedValue(undefined)
    trackPendingDelete('note-solo', 'solo-hash', 'notes/solo.md', onRealDelete)

    expect(checkForRename('solo-hash', 'notes/solo-renamed.md')).toEqual({
      id: 'note-solo',
      oldPath: 'notes/solo.md'
    })
    expect(getPendingDeleteCount()).toBe(0)
  })

  it('emits rename event when the caller completes the rename', async () => {
    processRename('note-2', 'notes/old-name.md', 'notes/new-name.md')

    expect(window.webContents.send).toHaveBeenCalledWith(
      NotesChannels.events.RENAMED,
      expect.objectContaining({
        id: 'note-2',
        oldPath: 'notes/old-name.md',
        newPath: 'notes/new-name.md',
        oldTitle: 'old-name',
        newTitle: 'new-name',
        source: 'external'
      })
    )
  })

  // ==========================================================================
  // T598: clearPendingDelete helpers
  // ==========================================================================
  it('clears pending deletes and prevents callbacks', async () => {
    vi.useFakeTimers()
    const onRealDelete = vi.fn().mockResolvedValue(undefined)

    trackPendingDelete('note-3', 'hash-3', 'notes/old.md', onRealDelete)
    trackPendingDelete('note-4', 'hash-4', 'notes/old-2.md', onRealDelete)

    expect(getPendingDeleteCount()).toBe(2)

    clearPendingDelete('note-3')
    expect(getPendingDeleteCount()).toBe(1)

    clearAllPendingDeletes()
    expect(hasPendingDeletes()).toBe(false)

    await vi.advanceTimersByTimeAsync(500)
    expect(onRealDelete).not.toHaveBeenCalled()
  })
})
