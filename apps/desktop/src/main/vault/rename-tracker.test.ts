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

    trackPendingDelete('note-1', 'notes/old.md', onRealDelete)

    expect(hasPendingDeletes()).toBe(true)
    expect(getPendingDeleteCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(500)

    expect(onRealDelete).toHaveBeenCalledTimes(1)
    expect(hasPendingDeletes()).toBe(false)
  })

  // ==========================================================================
  // T597: checkForRename reports rename without mutating cache inline
  // ==========================================================================
  it('returns the old path and leaves cache updates to the caller', async () => {
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

    trackPendingDelete('note-2', 'notes/old-name.md', vi.fn())

    const oldPath = await checkForRename('note-2', 'notes/new-name.md')

    expect(oldPath).toBe('notes/old-name.md')

    const unchanged = indexDb.db.select().from(noteCache).where(eq(noteCache.id, 'note-2')).get()

    expect(unchanged?.path).toBe('notes/old-name.md')
    expect(unchanged?.title).toBe('old-name')
    expect(window.webContents.send).not.toHaveBeenCalled()
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

    trackPendingDelete('note-3', 'notes/old.md', onRealDelete)
    trackPendingDelete('note-4', 'notes/old-2.md', onRealDelete)

    expect(getPendingDeleteCount()).toBe(2)

    clearPendingDelete('note-3')
    expect(getPendingDeleteCount()).toBe(1)

    clearAllPendingDeletes()
    expect(hasPendingDeletes()).toBe(false)

    await vi.advanceTimersByTimeAsync(500)
    expect(onRealDelete).not.toHaveBeenCalled()
  })
})
