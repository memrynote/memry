import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VAULT_LOCKED_NOTE_MESSAGE } from '@memry/contracts/vault-locks-api'
import { vaultLocks } from '@memry/db-schema/schema/vault-locks'
import {
  asClientDb,
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { insertNoteCache } from '@main/database/queries/notes/note-crud'

const state = vi.hoisted(() => ({
  data: null as unknown,
  index: null as unknown,
  vaultPath: '' as string
}))

const mocks = vi.hoisted(() => ({
  broadcast: vi.fn(),
  createSnapshot: vi.fn(),
  enqueueCreate: vi.fn(),
  enqueueUpdate: vi.fn(),
  folderExists: vi.fn(() => true)
}))

vi.mock('../database', () => ({
  getDatabase: () => state.data,
  getIndexDatabase: () => state.index,
  isDatabaseInitialized: () => state.data !== null,
  isIndexDatabaseInitialized: () => state.index !== null
}))
vi.mock('../vault/index', () => ({ getStatus: () => ({ path: state.vaultPath }) }))
vi.mock('../lib/window-broadcast', () => ({ broadcastToAllWindows: mocks.broadcast }))
vi.mock('../vault/notes-versions', () => ({ createSnapshot: mocks.createSnapshot }))
vi.mock('../vault/folders', () => ({ folderExists: mocks.folderExists }))
vi.mock('./runtime-effects', () => ({
  enqueueVaultLockCreate: mocks.enqueueCreate,
  enqueueVaultLockUpdate: mocks.enqueueUpdate
}))

import {
  assertFolderTreeWritable,
  assertFolderWritable,
  assertNoteWritable,
  getVaultLockState,
  invalidateVaultLocks,
  isNoteLocked,
  runWithLockedWritesAllowed
} from './registry'
import {
  afterLockedFileWriteSync,
  beforeVaultFileWrite,
  installVaultLockFileGuard,
  setFileReadOnly,
  setFileReadOnlySync,
  settleRemoteNoteFileSync,
  unprotectForRemoteWriteSync
} from './files'
import {
  checkLockedFilesAtOpen,
  onRemoteVaultLockApplied,
  restoreLockedNoteFile,
  scheduleLockedFileReconcile,
  setVaultLock
} from './service'
import { getBaseline, writeLockRow } from './store'
import { atomicWrite, deleteFile } from '../vault/file-ops'

const isWindows = process.platform === 'win32'

function isWritable(absolutePath: string): boolean {
  return (fs.statSync(absolutePath).mode & 0o200) !== 0
}

describe('vault read-only locks (#2606)', () => {
  let data: TestDatabaseResult
  let index: TestDatabaseResult
  let vault: string

  const addNote = (id: string, relativePath: string, body: string): string => {
    const absolute = path.join(vault, relativePath)
    fs.mkdirSync(path.dirname(absolute), { recursive: true })
    fs.writeFileSync(absolute, body)
    insertNoteCache(index.db, {
      id,
      path: relativePath,
      title: id,
      contentHash: `hash-${id}`,
      wordCount: 0,
      characterCount: 0,
      createdAt: '2026-01-10T00:00:00.000Z',
      modifiedAt: '2026-01-12T00:00:00.000Z'
    })
    return absolute
  }

  beforeEach(() => {
    vi.clearAllMocks()
    data = createTestDataDb()
    index = createTestIndexDb()
    state.data = data.db
    state.index = index.db
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-vault-locks-'))
    state.vaultPath = vault
    installVaultLockFileGuard()
  })

  afterEach(() => {
    for (const file of fs.readdirSync(vault, { recursive: true, withFileTypes: true })) {
      if (file.isFile()) fs.chmodSync(path.join(file.parentPath, file.name), 0o644)
    }
    fs.rmSync(vault, { recursive: true, force: true })
    data.close()
    index.close()
    state.data = null
    state.index = null
    invalidateVaultLocks()
  })

  it('locks a note: refused local writes, read-only file, baseline kept, synced as a create', async () => {
    const file = addNote('note-a', 'notes/a.md', '# A\n')

    const result = await setVaultLock({ kind: 'note', target: 'note-a', locked: true })

    expect(result).toEqual({ notes: ['note-a'], folders: [] })
    expect(mocks.enqueueCreate).toHaveBeenCalledWith('note:note-a')
    expect(isNoteLocked('note-a')).toBe(true)
    expect(() => assertNoteWritable('note-a')).toThrow(VAULT_LOCKED_NOTE_MESSAGE)
    expect(getBaseline(asClientDb(data.db), 'note-a')?.content).toBe('# A\n')
    if (!isWindows) expect(isWritable(file)).toBe(false)
  })

  it('unlocks with a locked:false update, never a delete, and makes the file writable', async () => {
    const file = addNote('note-a', 'notes/a.md', '# A\n')
    await setVaultLock({ kind: 'note', target: 'note-a', locked: true })

    const result = await setVaultLock({ kind: 'note', target: 'note-a', locked: false })

    expect(result).toEqual({ notes: [], folders: [] })
    expect(mocks.enqueueUpdate).toHaveBeenCalledWith('note:note-a')
    expect(data.db.select().from(vaultLocks).all()).toMatchObject([
      { id: 'note:note-a', locked: false }
    ])
    expect(() => assertNoteWritable('note-a')).not.toThrow()
    expect(getBaseline(asClientDb(data.db), 'note-a')).toBeUndefined()
    expect(isWritable(file)).toBe(true)
  })

  it('a folder lock covers its notes, subfolders and new notes, and blocks moving its parent', async () => {
    addNote('note-in', 'projects/plan/in.md', 'in\n')
    addNote('note-out', 'projects/out.md', 'out\n')

    await setVaultLock({ kind: 'folder', target: '/projects/plan/', locked: true })

    expect(getVaultLockState()).toEqual({ notes: [], folders: ['projects/plan'] })
    expect(isNoteLocked('note-in')).toBe(true)
    expect(isNoteLocked('note-out')).toBe(false)
    expect(() => assertFolderWritable('projects/plan/deeper')).toThrow(VAULT_LOCKED_NOTE_MESSAGE)
    expect(() => assertFolderWritable('projects')).not.toThrow()
    expect(() => assertFolderTreeWritable('projects')).toThrow(VAULT_LOCKED_NOTE_MESSAGE)
  })

  it('a folder holding a locked note cannot be renamed, moved or deleted', async () => {
    addNote('note-a', 'archive/a.md', 'a\n')
    await setVaultLock({ kind: 'note', target: 'note-a', locked: true })

    expect(() => assertFolderTreeWritable('archive')).toThrow(VAULT_LOCKED_NOTE_MESSAGE)
    expect(() => assertFolderTreeWritable('other')).not.toThrow()
  })

  it('remote applies and restores run inside the allowed scope', async () => {
    addNote('note-a', 'notes/a.md', 'a\n')
    await setVaultLock({ kind: 'note', target: 'note-a', locked: true })

    expect(() => runWithLockedWritesAllowed(() => assertNoteWritable('note-a'))).not.toThrow()
  })

  it('every vault write primitive refuses a locked file outside the allowed scope', async () => {
    const file = addNote('note-a', 'notes/a.md', 'a\n')
    addNote('note-b', 'notes/b.md', 'b\n')
    await setVaultLock({ kind: 'note', target: 'note-a', locked: true })

    await expect(beforeVaultFileWrite(file)).rejects.toThrow(VAULT_LOCKED_NOTE_MESSAGE)
    await expect(beforeVaultFileWrite(path.join(vault, 'notes/b.md'))).resolves.toBeNull()
    await expect(runWithLockedWritesAllowed(() => beforeVaultFileWrite(file))).resolves.toBe(
      'notes/a.md'
    )
    expect(isWritable(file)).toBe(true)
  })

  it('an outside edit is kept as a version and the locked text is written back', async () => {
    const file = addNote('note-a', 'notes/a.md', 'locked text\n')
    await setVaultLock({ kind: 'note', target: 'note-a', locked: true })
    fs.chmodSync(file, 0o644)
    fs.writeFileSync(file, 'outside edit\n')

    const restored = await restoreLockedNoteFile('note-a', 'outside edit\n')

    expect(restored).toBe(true)
    expect(mocks.createSnapshot).toHaveBeenCalledWith(
      'note-a',
      'outside edit\n',
      'note-a',
      'significant'
    )
    expect(fs.readFileSync(file, 'utf-8')).toBe('locked text\n')
    expect(mocks.broadcast).toHaveBeenCalledWith('vault-locks:external-edit-restored', {
      noteId: 'note-a',
      path: 'notes/a.md',
      title: 'note-a'
    })
  })

  it('leaves the outside edit on disk when the version cannot be kept', async () => {
    const file = addNote('note-a', 'notes/a.md', 'locked text\n')
    await setVaultLock({ kind: 'note', target: 'note-a', locked: true })
    fs.chmodSync(file, 0o644)
    fs.writeFileSync(file, 'outside edit\n')
    mocks.createSnapshot.mockImplementationOnce(() => {
      throw new Error('disk full')
    })

    expect(await restoreLockedNoteFile('note-a', 'outside edit\n')).toBe(false)
    expect(fs.readFileSync(file, 'utf-8')).toBe('outside edit\n')
  })

  it('a locked note deleted while the app was closed comes back at vault open', async () => {
    const file = addNote('note-a', 'notes/a.md', 'locked text\n')
    await setVaultLock({ kind: 'note', target: 'note-a', locked: true })
    fs.chmodSync(file, 0o644)
    fs.rmSync(file)

    await checkLockedFilesAtOpen()

    expect(fs.readFileSync(file, 'utf-8')).toBe('locked text\n')
    expect(mocks.createSnapshot).not.toHaveBeenCalled()
  })

  it('a write through the vault file primitives is refused for a locked note', async () => {
    const file = addNote('note-a', 'notes/a.md', 'a\n')
    await setVaultLock({ kind: 'note', target: 'note-a', locked: true })

    await expect(atomicWrite(file, 'agent text\n')).rejects.toThrow(VAULT_LOCKED_NOTE_MESSAGE)
    expect(fs.readFileSync(file, 'utf-8')).toBe('a\n')
  })

  it("leaves the app's own allowed write to a locked file alone when its change event is checked", async () => {
    const file = addNote('note-a', 'notes/a.md', 'locked text\n')
    await setVaultLock({ kind: 'note', target: 'note-a', locked: true })
    await runWithLockedWritesAllowed(() => atomicWrite(file, 'remote text\n'))

    expect(await restoreLockedNoteFile('note-a', 'remote text\n')).toBe(false)
    expect(fs.readFileSync(file, 'utf-8')).toBe('remote text\n')
    expect(mocks.createSnapshot).not.toHaveBeenCalled()
  })

  it('an unlocked note is never restored', async () => {
    addNote('note-a', 'notes/a.md', 'text\n')

    expect(await restoreLockedNoteFile('note-a', 'edit\n')).toBe(false)
  })

  /** A lock row as a pull writes it: no reconcile, no baseline yet. */
  const writeRemoteLock = (kind: 'note' | 'folder', target: string, locked: boolean): void => {
    writeLockRow(asClientDb(data.db), kind, target, locked)
    invalidateVaultLocks()
  }

  it('refuses to lock a note or folder that does not exist, and the vault root', async () => {
    await expect(setVaultLock({ kind: 'note', target: 'missing', locked: true })).rejects.toThrow(
      'Note not found: missing'
    )
    await expect(setVaultLock({ kind: 'folder', target: '/', locked: true })).rejects.toThrow(
      'Folder not found: '
    )
    mocks.folderExists.mockReturnValueOnce(false)
    await expect(setVaultLock({ kind: 'folder', target: 'gone', locked: true })).rejects.toThrow(
      'Folder not found: gone'
    )
    expect(getVaultLockState()).toEqual({ notes: [], folders: [] })
    expect(mocks.enqueueCreate).not.toHaveBeenCalled()
  })

  it('a folder lock makes its other files read-only, and unlocking frees only what no lock still covers', async () => {
    const note = addNote('note-in', 'projects/in.md', 'in\n')
    const pdf = path.join(vault, 'projects/scan.pdf')
    fs.writeFileSync(pdf, 'pdf')
    const innerLocked = addNote('note-own', 'projects/own.md', 'own\n')
    const innerFolderFile = path.join(vault, 'projects/sealed/doc.pdf')
    fs.mkdirSync(path.dirname(innerFolderFile), { recursive: true })
    fs.writeFileSync(innerFolderFile, 'doc')
    // A folder the lock names but that is not on disk is skipped, not an error.
    await setVaultLock({ kind: 'folder', target: 'not-on-disk', locked: true })

    await setVaultLock({ kind: 'note', target: 'note-own', locked: true })
    await setVaultLock({ kind: 'folder', target: 'projects/sealed', locked: true })
    await setVaultLock({ kind: 'folder', target: 'projects', locked: true })
    if (!isWindows) expect([note, pdf].map(isWritable)).toEqual([false, false])

    await setVaultLock({ kind: 'folder', target: 'projects', locked: false })

    expect(isWritable(note)).toBe(true)
    expect(isWritable(pdf)).toBe(true)
    if (!isWindows) expect([innerLocked, innerFolderFile].map(isWritable)).toEqual([false, false])
    expect(mocks.broadcast).toHaveBeenLastCalledWith('vault-locks:changed', {
      notes: ['note-own'],
      folders: ['not-on-disk', 'projects/sealed']
    })
  })

  it('a lock pulled from another device protects the file and tells the windows', async () => {
    const file = addNote('note-a', 'notes/a.md', 'a\n')
    writeRemoteLock('note', 'note-a', true)

    onRemoteVaultLockApplied()

    await vi.waitFor(() =>
      expect(mocks.broadcast).toHaveBeenCalledWith('vault-locks:changed', {
        notes: ['note-a'],
        folders: []
      })
    )
    expect(getBaseline(asClientDb(data.db), 'note-a')?.content).toBe('a\n')
    if (!isWindows) expect(isWritable(file)).toBe(false)
  })

  it('reconciles once, a second after the first of several remote applies', async () => {
    const file = addNote('note-a', 'notes/a.md', 'a\n')
    writeRemoteLock('note', 'note-a', true)
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      scheduleLockedFileReconcile()
      scheduleLockedFileReconcile()
      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(1000)
    } finally {
      vi.useRealTimers()
    }

    await vi.waitFor(() => {
      expect(getBaseline(asClientDb(data.db), 'note-a')).toBeDefined()
      if (!isWindows) expect(isWritable(file)).toBe(false)
    })
  })

  it('takes the bytes on disk as the locked text when a lock has none yet', async () => {
    addNote('note-a', 'notes/a.md', 'current\n')
    writeRemoteLock('note', 'note-a', true)

    expect(await restoreLockedNoteFile('note-a', 'current\n')).toBe(false)

    expect(getBaseline(asClientDb(data.db), 'note-a')?.content).toBe('current\n')
    expect(mocks.createSnapshot).not.toHaveBeenCalled()
  })

  it('a remote write to a locked file is let through and the file is protected again after', () => {
    const file = addNote('note-a', 'notes/a.md', 'a\n')
    writeRemoteLock('note', 'note-a', true)
    setFileReadOnlySync(file, true)

    expect(unprotectForRemoteWriteSync(file)).toBe('notes/a.md')
    expect(isWritable(file)).toBe(true)
    fs.writeFileSync(file, 'remote\n')
    afterLockedFileWriteSync(file, 'notes/a.md', 'remote\n')

    if (!isWindows) expect(isWritable(file)).toBe(false)
    expect(getBaseline(asClientDb(data.db), 'note-a')?.content).toBe('remote\n')
    expect(unprotectForRemoteWriteSync(path.join(vault, 'notes/free.md'))).toBeNull()
    expect(() => setFileReadOnlySync(path.join(vault, 'notes/missing.md'), true)).not.toThrow()
  })

  const modeOf = (absolutePath: string): number => fs.statSync(absolutePath).mode & 0o777

  it.skipIf(isWindows)(
    'unlocking gives every file the exact mode it had before the lock, after app writes too',
    async () => {
      const note = addNote('note-a', 'notes/a.md', 'a\n')
      const pdfNote = addNote('note-pdf', 'notes/scan.pdf', 'pdf')
      const folderFile = path.join(vault, 'shared/doc.pdf')
      fs.mkdirSync(path.dirname(folderFile), { recursive: true })
      fs.writeFileSync(folderFile, 'doc')
      for (const file of [note, pdfNote, folderFile]) fs.chmodSync(file, 0o664)

      await setVaultLock({ kind: 'note', target: 'note-a', locked: true })
      await setVaultLock({ kind: 'note', target: 'note-pdf', locked: true })
      await setVaultLock({ kind: 'folder', target: 'shared', locked: true })
      expect([note, pdfNote, folderFile].map(modeOf)).toEqual([0o444, 0o444, 0o444])

      await runWithLockedWritesAllowed(() => atomicWrite(note, 'remote\n'))
      expect(modeOf(note)).toBe(0o444)

      await setVaultLock({ kind: 'note', target: 'note-a', locked: false })
      await setVaultLock({ kind: 'note', target: 'note-pdf', locked: false })
      await setVaultLock({ kind: 'folder', target: 'shared', locked: false })

      expect([note, pdfNote, folderFile].map(modeOf)).toEqual([0o664, 0o664, 0o664])
    }
  )

  it.skipIf(isWindows || process.getuid?.() === 0)(
    'an allowed delete that fails leaves the locked file read-only',
    async () => {
      const file = addNote('note-a', 'notes/a.md', 'a\n')
      await setVaultLock({ kind: 'note', target: 'note-a', locked: true })
      fs.chmodSync(path.dirname(file), 0o555)
      try {
        await expect(runWithLockedWritesAllowed(() => deleteFile(file))).rejects.toThrow(
          'Failed to delete file'
        )
      } finally {
        fs.chmodSync(path.dirname(file), 0o755)
      }

      expect(fs.readFileSync(file, 'utf-8')).toBe('a\n')
      expect(isWritable(file)).toBe(false)
    }
  )

  it("a locked note's attachments are read-only on disk, refused to local writes, and freed on unlock", async () => {
    addNote('note-a', 'notes/a.md', 'a\n')
    addNote('note-in', 'archive/in.md', 'in\n')
    const own = path.join(vault, 'attachments/note-a/photo.png')
    const viaFolder = path.join(vault, 'attachments/note-in/scan.pdf')
    const other = path.join(vault, 'attachments/note-free/x.png')
    for (const file of [own, viaFolder, other]) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, 'bytes')
      fs.chmodSync(file, 0o644)
    }

    await setVaultLock({ kind: 'note', target: 'note-a', locked: true })
    await setVaultLock({ kind: 'folder', target: 'archive', locked: true })

    if (!isWindows) expect([own, viaFolder, other].map(isWritable)).toEqual([false, false, true])
    await expect(beforeVaultFileWrite(own)).rejects.toThrow(VAULT_LOCKED_NOTE_MESSAGE)
    await expect(beforeVaultFileWrite(viaFolder)).rejects.toThrow(VAULT_LOCKED_NOTE_MESSAGE)
    await expect(beforeVaultFileWrite(other)).resolves.toBeNull()

    await setVaultLock({ kind: 'note', target: 'note-a', locked: false })
    await setVaultLock({ kind: 'folder', target: 'archive', locked: false })

    expect([own, viaFolder].map(isWritable)).toEqual([true, true])
    if (!isWindows) expect([own, viaFolder].map(modeOf)).toEqual([0o644, 0o644])
  })

  it('settles a synced note file: protected while locked, writable once moved out of the lock', () => {
    const file = addNote('note-a', 'archive/a.md', 'a\n')
    writeRemoteLock('folder', 'archive', true)

    settleRemoteNoteFileSync('note-a', file, 'archive/a.md', 'pulled\n')

    if (!isWindows) expect(isWritable(file)).toBe(false)
    expect(getBaseline(asClientDb(data.db), 'note-a')?.content).toBe('pulled\n')

    const moved = path.join(vault, 'notes/a.md')
    fs.mkdirSync(path.dirname(moved), { recursive: true })
    fs.renameSync(file, moved)
    settleRemoteNoteFileSync('note-a', moved, 'notes/a.md', null)

    expect(isWritable(moved)).toBe(true)
    expect(getBaseline(asClientDb(data.db), 'note-a')).toBeUndefined()
  })
})

/**
 * Windows has one read-only attribute and no permission bits. Node's chmod sets
 * that attribute when the mode has no write bit and clears it when the owner
 * write bit is set, and stat reports 0o444 or 0o666 back. These pin the modes
 * the lock asks for, whatever platform runs the test.
 */
describe('read-only attribute modes (#2606)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function stubFileMode(mode: number): ReturnType<typeof vi.fn> {
    vi.spyOn(fs.promises, 'stat').mockResolvedValue({ mode } as fs.Stats)
    vi.spyOn(fs, 'statSync').mockReturnValue({ mode } as fs.Stats)
    const chmods = vi.fn()
    vi.spyOn(fs.promises, 'chmod').mockImplementation(async (_file, next) => chmods(next))
    vi.spyOn(fs, 'chmodSync').mockImplementation((_file, next) => chmods(next))
    return chmods
  }

  it('locking drops every write bit, so Windows sets the read-only attribute', async () => {
    const chmods = stubFileMode(0o100666)

    await setFileReadOnly('/vault/a.md', true)
    setFileReadOnlySync('/vault/a.md', true)

    expect(chmods.mock.calls).toEqual([[0o444], [0o444]])
  })

  it('unlocking sets the owner write bit, so Windows clears the read-only attribute', async () => {
    const chmods = stubFileMode(0o100444)

    await setFileReadOnly('/vault/a.md', false)
    setFileReadOnlySync('/vault/a.md', false)

    expect(chmods.mock.calls).toEqual([[0o644], [0o644]])
  })

  it('leaves a file alone when it already has the wanted attribute', async () => {
    const chmods = stubFileMode(0o100444)

    await setFileReadOnly('/vault/a.md', true)
    setFileReadOnlySync('/vault/a.md', true)

    expect(chmods).not.toHaveBeenCalled()
  })
})
