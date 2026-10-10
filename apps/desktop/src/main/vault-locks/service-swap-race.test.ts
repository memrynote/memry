import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { vaultLocks } from '@memry/db-schema/schema/vault-locks'
import {
  asClientDb,
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { insertNoteCache } from '@main/database/queries/notes/note-crud'

// The seam: right after the outside-vault check resolves a locked note file,
// the file is swapped for a link to a file outside the vault, before it is read.
const race = vi.hoisted(() => ({ target: '', swap: (): void => {} }))

function swapOnce(probe: unknown): void {
  if (race.target === '' || probe !== race.target) return
  race.target = ''
  race.swap()
}

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  const realpath = async (probe: string): Promise<string> => {
    const real = await actual.realpath(probe)
    swapOnce(probe)
    return real
  }
  return { ...actual, default: { ...actual, realpath }, realpath }
})
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const native = (probe: string): string => {
    const real = actual.realpathSync.native(probe)
    swapOnce(probe)
    return real
  }
  const realpathSync = Object.assign((probe: string) => actual.realpathSync(probe), { native })
  return { ...actual, default: { ...actual, realpathSync }, realpathSync }
})

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

import { installVaultLockFileGuard } from './files'
import { invalidateVaultLocks } from './registry'
import { checkLockedFilesAtOpen, reconcileLockedFiles, setVaultLock } from './service'
import { getBaseline } from './store'

const isWindows = process.platform === 'win32'

describe('a locked note file swapped for an outside link after the vault check (#3095)', () => {
  let data: TestDatabaseResult
  let index: TestDatabaseResult
  let vault: string
  let outside: string
  let secret: string

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

  const arm = (file: string): void => {
    race.target = file
    race.swap = () => {
      fs.rmSync(file)
      fs.symlinkSync(secret, file)
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    data = createTestDataDb()
    index = createTestIndexDb()
    state.data = data.db
    state.index = index.db
    vault = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memry-swap-vault-')))
    state.vaultPath = vault
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-swap-outside-'))
    secret = path.join(outside, 'private.md')
    fs.writeFileSync(secret, 'outside secret\n')
    installVaultLockFileGuard()
  })

  afterEach(() => {
    race.target = ''
    data.db.delete(vaultLocks).run()
    invalidateVaultLocks()
    fs.rmSync(vault, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
    data.close()
    index.close()
    state.data = null
    state.index = null
    invalidateVaultLocks()
  })

  it.skipIf(isWindows)('locking keeps no baseline holding the outside bytes', async () => {
    const file = addNote('note-a', 'notes/a.md', 'vault text\n')
    arm(file)

    await setVaultLock({ kind: 'note', target: 'note-a', locked: true })

    expect(getBaseline(asClientDb(data.db), 'note-a')?.content ?? '').not.toContain(
      'outside secret'
    )
  })

  it.skipIf(isWindows)(
    'reconciling a folder lock keeps no baseline holding the outside bytes',
    async () => {
      const file = addNote('note-a', 'notes/a.md', 'vault text\n')
      await setVaultLock({ kind: 'folder', target: 'notes', locked: true })
      fs.chmodSync(file, 0o644)
      const { writeLockRow } = await import('./store')
      writeLockRow(asClientDb(data.db), 'note', 'note-a', true)
      invalidateVaultLocks()
      // drop the baseline the first lock wrote, so reconcile has to read again
      const { deleteBaseline } = await import('./store')
      deleteBaseline(asClientDb(data.db), 'note-a')
      arm(file)

      await reconcileLockedFiles()

      expect(getBaseline(asClientDb(data.db), 'note-a')?.content ?? '').not.toContain(
        'outside secret'
      )
    }
  )

  it.skipIf(isWindows)(
    'at vault open, never versions the outside bytes or acts on the outside file',
    async () => {
      const file = addNote('note-a', 'notes/a.md', 'locked text\n')
      await setVaultLock({ kind: 'note', target: 'note-a', locked: true })
      fs.chmodSync(file, 0o644)
      arm(file)

      await checkLockedFilesAtOpen()

      expect(mocks.createSnapshot).not.toHaveBeenCalled()
      expect(getBaseline(asClientDb(data.db), 'note-a')?.content).toBe('locked text\n')
      expect(fs.lstatSync(file).isSymbolicLink()).toBe(true)
      expect(fs.readFileSync(secret, 'utf-8')).toBe('outside secret\n')
    }
  )
})
