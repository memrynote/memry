import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { folderConfigs } from '@memry/db-schema/schema/folder-configs'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'

const mocks = vi.hoisted(() => ({
  db: null as unknown,
  vaultPath: '/vault' as string | null,
  folders: [] as { path: string; icon: string | null }[],
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn()
}))

vi.mock('../database', () => ({ getDatabase: () => mocks.db }))
vi.mock('../vault/notes', () => ({ getFolders: async () => mocks.folders }))
vi.mock('../store', () => ({ getCurrentVaultPath: () => mocks.vaultPath }))
vi.mock('../sync/local-mutations', () => ({
  enqueueLocalSyncCreate: mocks.enqueueLocalSyncCreate,
  enqueueLocalSyncUpdate: mocks.enqueueLocalSyncUpdate,
  enqueueLocalSyncDelete: mocks.enqueueLocalSyncDelete
}))

import {
  backfillFolderConfigs,
  syncFolderConfigCreate,
  syncFolderConfigDelete,
  syncFolderConfigRename
} from './folder-config-effects'

let testDb: TestDatabaseResult

function paths(): string[] {
  return testDb.db
    .select({ path: folderConfigs.path })
    .from(folderConfigs)
    .all()
    .map((r) => r.path)
}

beforeEach(() => {
  testDb = createTestDataDb()
  mocks.db = testDb.db
  mocks.vaultPath = '/vault'
  mocks.folders = []
  mocks.enqueueLocalSyncCreate.mockClear()
  mocks.enqueueLocalSyncUpdate.mockClear()
  mocks.enqueueLocalSyncDelete.mockClear()
})

afterEach(() => {
  testDb.close()
})

describe('syncFolderConfigCreate', () => {
  it('writes a row and queues a create so an empty folder reaches other devices', () => {
    syncFolderConfigCreate('Projects')

    expect(paths()).toEqual(['Projects'])
    expect(mocks.enqueueLocalSyncCreate).toHaveBeenCalledWith('folder_config', 'Projects')
  })

  it('ignores the vault root', () => {
    syncFolderConfigCreate('')

    expect(paths()).toEqual([])
    expect(mocks.enqueueLocalSyncCreate).not.toHaveBeenCalled()
  })
})

describe('syncFolderConfigDelete', () => {
  it('tombstones descendants too, so they cannot re-create the folder', () => {
    syncFolderConfigCreate('Projects')
    syncFolderConfigCreate('Projects/2026')
    syncFolderConfigCreate('Projects other')

    syncFolderConfigDelete('Projects')

    expect(paths()).toEqual(['Projects other'])
    const deleted = mocks.enqueueLocalSyncDelete.mock.calls.map((c) => c[1])
    expect(deleted.sort()).toEqual(['Projects', 'Projects/2026'])
  })
})

describe('syncFolderConfigRename', () => {
  it('re-keys the whole subtree', () => {
    syncFolderConfigCreate('Projects')
    syncFolderConfigCreate('Projects/2026/Q1')

    syncFolderConfigRename('Projects', 'Work')

    expect(paths().sort()).toEqual(['Work', 'Work/2026/Q1'])
  })
})

describe('backfillFolderConfigs', () => {
  it('queues folders that exist on disk but have no row, and is a no-op after', async () => {
    mocks.folders = [
      { path: 'Projects', icon: null },
      { path: 'Projects/2026', icon: null }
    ]

    expect(await backfillFolderConfigs()).toBe(2)
    expect(paths().sort()).toEqual(['Projects', 'Projects/2026'])

    mocks.enqueueLocalSyncCreate.mockClear()
    expect(await backfillFolderConfigs()).toBe(0)
    expect(mocks.enqueueLocalSyncCreate).not.toHaveBeenCalled()
  })

  it('does nothing when no vault is open', async () => {
    mocks.vaultPath = null
    mocks.folders = [{ path: 'Projects', icon: null }]

    expect(await backfillFolderConfigs()).toBe(0)
    expect(paths()).toEqual([])
  })
})
