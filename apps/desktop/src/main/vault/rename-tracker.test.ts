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

const probe = vi.hoisted(() => ({ real: null as boolean | null }))
vi.mock('./birthtime-probe', () => ({ birthtimeIsReal: () => probe.real }))

import { getDatabase, getIndexDatabase } from '../database'
import {
  trackPendingDelete,
  checkForRename,
  processRename,
  clearPendingDelete,
  clearAllPendingDeletes,
  hasPendingDeletes,
  getPendingDeleteCount,
  createDeferredDeletes,
  forgetRenameTarget,
  settleDeferredDeletes,
  buildAddedFileIdentityKey,
  buildFileIdentityKey,
  buildStatRenameKey
} from './rename-tracker'
import { withAppFolderChange } from './app-folder-changes'

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

  it('settles only the deferred deletes of the rescan that created them (#3026)', async () => {
    const first = createDeferredDeletes()
    const second = createDeferredDeletes()
    const deleteA = vi.fn().mockResolvedValue(undefined)
    const deleteB = vi.fn().mockResolvedValue(undefined)
    trackPendingDelete('note-a', 'hash-a', 'notes/a.md', deleteA, null, first)
    trackPendingDelete('note-b', 'hash-b', 'notes/b.md', deleteB, null, second)

    await settleDeferredDeletes(first)

    expect(deleteA).toHaveBeenCalledTimes(1)
    expect(deleteB).not.toHaveBeenCalled()
    // The second rescan's add still pairs with its delete as a rename.
    expect(checkForRename('hash-b', 'notes/b-moved.md')).toMatchObject({ id: 'note-b' })

    await settleDeferredDeletes(second)
    expect(deleteB).not.toHaveBeenCalled()
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

  it('holds a delete under a folder the app is moving until the move ends (#5695)', async () => {
    vi.useFakeTimers()
    const timed = vi.fn().mockResolvedValue(undefined)
    const deferred = vi.fn().mockResolvedValue(undefined)
    const rescan = createDeferredDeletes()
    let finishMove = (): void => {}
    const move = withAppFolderChange(
      ['Big'],
      () => new Promise<void>((resolve) => (finishMove = resolve))
    )

    trackPendingDelete('note-1', 'hash-1', 'Big/Sub/a.md', timed)
    trackPendingDelete('note-2', 'hash-2', 'Big/b.md', deferred, null, rescan)
    await settleDeferredDeletes(rescan)
    await vi.advanceTimersByTimeAsync(10_000)

    expect(timed).not.toHaveBeenCalled()
    expect(deferred).not.toHaveBeenCalled()
    // The moved file's add still pairs with its delete as a rename.
    expect(checkForRename('hash-1', 'Renamed/Sub/a.md')).toMatchObject({ id: 'note-1' })

    finishMove()
    await move
    await vi.advanceTimersByTimeAsync(500)
    expect(deferred).toHaveBeenCalledTimes(1)
  })

  // The file's own rename event named the file it became: only that file's add
  // takes the delete, ahead of older deletes of the same bytes, and a copy or
  // a template note with the same bytes never does.
  it('pairs a delete whose new path is known only with the add at that path', () => {
    trackPendingDelete('note-older', 'hash-same', 'notes/older.md', vi.fn())
    trackPendingDelete('note-a', 'hash-same', 'notes/a.md', vi.fn(), null, null, 'notes/b.md')

    expect(checkForRename('hash-same', 'notes/b.md')).toMatchObject({ id: 'note-a' })

    trackPendingDelete('note-c', 'hash-same', 'notes/c.md', vi.fn(), null, null, 'notes/d.md')
    expect(checkForRename('hash-same', 'notes/copy.md')).toMatchObject({ id: 'note-older' })
    expect(checkForRename('hash-same', 'notes/copy-2.md')).toBeNull()
    expect(checkForRename('hash-same', 'notes/d.md')).toMatchObject({ id: 'note-c' })
  })

  // A move to another folder under a new name names the new name in the old
  // folder: the add there runs and does not take the delete.
  it('pairs a delete with any add once the add at its named path did not take it', () => {
    trackPendingDelete('note-a', 'hash-a', 'Docs/a.md', vi.fn(), null, null, 'Docs/b.md')
    expect(checkForRename('hash-a', 'Other/b.md')).toBeNull()

    forgetRenameTarget('note-a')
    expect(checkForRename('hash-a', 'Other/b.md')).toMatchObject({ id: 'note-a' })
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

    expect(match).toMatchObject({ id: 'note-2', oldPath: 'notes/old-name.md' })

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

  it('matches a changed file only by its own inode and birthtime, never by size + mtime alone', () => {
    const mtime = new Date('2026-01-12T00:00:00.000Z')
    const changed = {
      dev: 1,
      ino: 42,
      birthtime: new Date('2026-01-10T00:00:00.000Z'),
      birthtimeMs: Date.parse('2026-01-10T00:00:00.000Z'),
      ctimeMs: mtime.getTime(),
      size: 20,
      mtime
    }
    trackPendingDelete('note-c', 'stale-hash', 'notes/c.md', vi.fn(), buildFileIdentityKey(changed))

    const lookalike = { ...changed, ino: 43 }
    const lookalikeKeys = [
      buildFileIdentityKey(lookalike),
      buildStatRenameKey(20, mtime.toISOString())
    ]
    expect(checkForRename('new-hash', 'notes/other.md', lookalikeKeys)).toBeNull()
    // ext4 hands the freed inode to the next file, which has its own birthtime.
    const reborn = new Date()
    const reusedInode = buildFileIdentityKey({
      ...changed,
      birthtime: reborn,
      birthtimeMs: reborn.getTime()
    })
    expect(checkForRename('new-hash', 'notes/other.md', [reusedInode])).toBeNull()
    expect(
      checkForRename('new-hash', 'notes/c-renamed.md', [buildFileIdentityKey(changed)])
    ).toMatchObject({ id: 'note-c' })
    // Some filesystems report no inode or no birthtime: no identity key.
    expect(buildFileIdentityKey({ ...changed, ino: 0 })).toBeNull()
    expect(buildFileIdentityKey({ ...changed, birthtime: new Date(0) })).toBeNull()
    // Linux without statx reports the ctime as birthtime.
    expect(buildFileIdentityKey({ ...changed, birthtimeMs: changed.ctimeMs })).toBeNull()
  })

  it('keys a file whose birthtime equals its ctime once the probe found real birthtimes', () => {
    // A file written right after it was created on ext4 or tmpfs: statx reports
    // a real birthtime, in the same timestamp tick as the ctime.
    const fresh = new Date('2026-01-12T00:00:00.000Z')
    const linuxFresh = {
      dev: 1,
      ino: 42,
      birthtime: fresh,
      birthtimeMs: fresh.getTime(),
      ctimeMs: fresh.getTime(),
      size: 20,
      mtime: fresh
    }
    try {
      probe.real = true
      const key = buildFileIdentityKey(linuxFresh)
      expect(key).not.toBeNull()
      trackPendingDelete('note-f', 'stale-hash', 'notes/f.md', vi.fn(), key)
      // ext4 hands the freed inode to a file born later: its own key.
      const reborn = new Date(fresh.getTime() + 1)
      const reused = buildFileIdentityKey({
        ...linuxFresh,
        birthtime: reborn,
        birthtimeMs: reborn.getTime(),
        ctimeMs: reborn.getTime()
      })
      expect(checkForRename('new-hash', 'notes/other.md', [reused])).toBeNull()
      expect(checkForRename('new-hash', 'notes/f-renamed.md', [key])).toMatchObject({
        id: 'note-f'
      })
      // No birthtime still means no key.
      expect(buildFileIdentityKey({ ...linuxFresh, birthtime: new Date(0) })).toBeNull()

      // libuv reports the ctime as birthtime: no file has an identity.
      probe.real = false
      expect(buildFileIdentityKey(linuxFresh)).toBeNull()
      expect(
        buildFileIdentityKey({ ...linuxFresh, birthtimeMs: 1, birthtime: new Date(1) })
      ).toBeNull()
    } finally {
      probe.real = null
    }
  })

  // After the probe found real birthtimes, libuv can fall back to stat(2) for
  // the rest of the process and report the ctime as every birthtime (#5247
  // A24). With 1 s timestamps a file written on a deleted note's freed inode
  // the same second then shares the note's whole key.
  it('pairs no add by identity once Linux stat reports the ctime as birthtime', async () => {
    vi.useFakeTimers()
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    probe.real = true
    try {
      const second = new Date('2026-01-12T00:00:01.000Z')
      const deleted = {
        dev: 1,
        ino: 42,
        birthtime: second,
        birthtimeMs: second.getTime(),
        ctimeMs: second.getTime(),
        size: 20,
        mtime: second
      }
      const onRealDelete = vi.fn().mockResolvedValue(undefined)
      trackPendingDelete(
        'note-a',
        'hash-a',
        'notes/a.md',
        onRealDelete,
        buildFileIdentityKey(deleted)
      )

      const unrelated = { ...deleted }
      const unrelatedKeys = [buildAddedFileIdentityKey(unrelated)]
      expect(checkForRename('hash-b', 'notes/b.md', unrelatedKeys)).toBeNull()
      await vi.advanceTimersByTimeAsync(500)
      expect(onRealDelete).toHaveBeenCalledOnce()

      // With statx a rename moves the ctime past the real birthtime.
      const born = new Date('2026-01-10T00:00:00.000Z')
      const changed = { ...deleted, birthtime: born, birthtimeMs: born.getTime() }
      trackPendingDelete(
        'note-c',
        'stale-hash',
        'notes/c.md',
        vi.fn(),
        buildFileIdentityKey(changed)
      )
      const renamed = { ...changed, ctimeMs: second.getTime() + 5 }
      expect(
        checkForRename('new-hash', 'notes/c-renamed.md', [buildAddedFileIdentityKey(renamed)])
      ).toMatchObject({ id: 'note-c' })
    } finally {
      probe.real = null
      if (platform) Object.defineProperty(process, 'platform', platform)
    }
  })

  it('matches identical-hash collisions FIFO, oldest pending delete first', async () => {
    vi.useFakeTimers()
    const onRealDeleteA = vi.fn().mockResolvedValue(undefined)
    const onRealDeleteB = vi.fn().mockResolvedValue(undefined)

    trackPendingDelete('note-a', 'same-hash', 'notes/a.md', onRealDeleteA)
    trackPendingDelete('note-b', 'same-hash', 'notes/b.md', onRealDeleteB)
    expect(getPendingDeleteCount()).toBe(2)

    expect(checkForRename('same-hash', 'notes/a-renamed.md')).toMatchObject({
      id: 'note-a',
      oldPath: 'notes/a.md'
    })
    expect(checkForRename('same-hash', 'notes/b-renamed.md')).toMatchObject({
      id: 'note-b',
      oldPath: 'notes/b.md'
    })
    expect(checkForRename('same-hash', 'notes/c.md')).toBeNull()

    await vi.advanceTimersByTimeAsync(500)
    expect(onRealDeleteA).not.toHaveBeenCalled()
    expect(onRealDeleteB).not.toHaveBeenCalled()
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
