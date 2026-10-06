import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  VAULT_LOCKED_FOLDER_MESSAGE,
  VAULT_LOCKED_NOTE_MESSAGE
} from '@memry/contracts/vault-locks-api'
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
import { beforeVaultFileWrite, installVaultLockFileGuard } from './files'
import { checkLockedFilesAtOpen, restoreLockedNoteFile, setVaultLock } from './service'
import { getBaseline } from './store'
import { atomicWrite } from '../vault/file-ops'

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
    expect(() => assertFolderWritable('projects/plan/deeper')).toThrow(VAULT_LOCKED_FOLDER_MESSAGE)
    expect(() => assertFolderWritable('projects')).not.toThrow()
    expect(() => assertFolderTreeWritable('projects')).toThrow(VAULT_LOCKED_FOLDER_MESSAGE)
  })

  it('a folder holding a locked note cannot be renamed, moved or deleted', async () => {
    addNote('note-a', 'archive/a.md', 'a\n')
    await setVaultLock({ kind: 'note', target: 'note-a', locked: true })

    expect(() => assertFolderTreeWritable('archive')).toThrow(VAULT_LOCKED_FOLDER_MESSAGE)
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

  it('an unlocked note is never restored', async () => {
    addNote('note-a', 'notes/a.md', 'text\n')

    expect(await restoreLockedNoteFile('note-a', 'edit\n')).toBe(false)
  })
})
