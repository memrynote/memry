import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const nativeFailure = vi.hoisted((): { error: Error | null } => ({ error: null }))

vi.mock('better-sqlite3', async (importOriginal) => {
  const original = await importOriginal<{ default: typeof Database }>()
  return {
    ...original,
    default: vi.fn(function (filename: string, options?: Database.Options) {
      if (nativeFailure.error) throw nativeFailure.error
      return new original.default(filename, options)
    })
  }
})

const { mockUpsertVault, mockCreateVaultInfo, mockRecordCrdtStoreRename } = vi.hoisted(() => ({
  mockUpsertVault: vi.fn(),
  mockRecordCrdtStoreRename: vi.fn(),
  mockCreateVaultInfo: vi.fn((vaultPath: string) => ({
    path: vaultPath,
    name: path.basename(vaultPath),
    noteCount: 0,
    taskCount: 0,
    lastOpened: '2026-06-09T00:00:00.000Z',
    isDefault: false
  }))
}))

vi.mock('../store', () => ({
  upsertVault: mockUpsertVault,
  recordCrdtStoreRename: mockRecordCrdtStoreRename,
  getVaults: vi.fn(() => []),
  getCurrentVaultPath: vi.fn(() => null),
  getAccountVaultsCache: vi.fn(() => ({
    fetchedAt: 1,
    vaults: [{ vaultUuid: 'server-vault-uuid', name: 'My Notes', itemCount: 1, createdAt: 1 }]
  }))
}))

vi.mock('../vault/status', async () => await import('../vault'))
vi.mock('../vault', () => ({
  createVaultInfo: mockCreateVaultInfo,
  selectVault: vi.fn()
}))

vi.mock('electron', () => ({ app: { getPath: vi.fn() } }))
vi.mock('./bootstrap-metrics', () => ({
  beginBootstrap: vi.fn(),
  markBootstrapInteractive: vi.fn(),
  abandonBootstrap: vi.fn()
}))

import { closeDatabase, getRawDataDatabase, initDatabase } from '../database/client'
import { getVaults } from '../store'
import { selectVault } from '../vault'
import { downloadRemoteVault } from './vault-directory'
import { createDormantVault, dormantVaultFolderName } from './vault-provisioning'

describe('vault-provisioning', () => {
  let parentDir: string

  beforeEach(() => {
    vi.clearAllMocks()
    nativeFailure.error = null
    vi.mocked(getVaults).mockReturnValue([])
    parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-dormant-'))
  })

  afterEach(() => {
    nativeFailure.error = null
    vi.restoreAllMocks()
    closeDatabase()
    fs.rmSync(parentDir, { recursive: true, force: true })
  })

  it('does not replace the active vault database while provisioning another vault', () => {
    const activePath = path.join(parentDir, 'active.db')
    initDatabase(activePath)
    getRawDataDatabase().exec('CREATE TABLE user_notes (body TEXT)')
    getRawDataDatabase().exec("INSERT INTO user_notes VALUES ('keep me')")

    createDormantVault(path.join(parentDir, 'downloaded'), 'server-vault-uuid')

    expect(getRawDataDatabase().name).toBe(activePath)
    expect(getRawDataDatabase().prepare('SELECT body FROM user_notes').get()).toEqual({
      body: 'keep me'
    })
  })

  it('leaves no download folders or registry entries when the native adapter cannot load', async () => {
    nativeFailure.error = new Error("libm.so.6: version 'GLIBC_2.38' not found")
    const destination = path.join(parentDir, 'Memry')

    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        downloadRemoteVault({ vaultUuid: 'server-vault-uuid', parentPath: destination })
      ).rejects.toThrow('GLIBC_2.38')
    }

    expect(fs.readdirSync(parentDir)).toEqual([])
    expect(mockUpsertVault).not.toHaveBeenCalled()
  })

  it('removes only the failed attempt after a filesystem write failure', async () => {
    const previous = path.join(parentDir, 'my-notes')
    fs.mkdirSync(previous)
    fs.writeFileSync(path.join(previous, 'keep.md'), 'existing vault content')
    const writeFile = fs.writeFileSync.bind(fs)
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
      if (String(file) === path.join(parentDir, 'my-notes-2', '.memry', 'config.json')) {
        throw Object.assign(new Error('No space left on device'), { code: 'ENOSPC' })
      }
      return writeFile(file, ...args)
    })

    await expect(
      downloadRemoteVault({ vaultUuid: 'server-vault-uuid', parentPath: parentDir })
    ).rejects.toThrow('No space left on device')

    expect(fs.readdirSync(parentDir)).toEqual(['my-notes'])
    expect(fs.readFileSync(path.join(previous, 'keep.md'), 'utf8')).toBe('existing vault content')
    expect(mockUpsertVault).not.toHaveBeenCalled()
  })

  it('does not delete a user file that appears in an attempted download folder', async () => {
    const dir = path.join(parentDir, 'my-notes')
    const writeFile = fs.writeFileSync.bind(fs)
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
      if (String(file) === path.join(dir, '.memry', 'config.json')) {
        writeFile(path.join(dir, 'user-note.md'), 'written by another process')
        throw Object.assign(new Error('No space left on device'), { code: 'ENOSPC' })
      }
      return writeFile(file, ...args)
    })

    await expect(
      downloadRemoteVault({ vaultUuid: 'server-vault-uuid', parentPath: parentDir })
    ).rejects.toThrow('No space left on device')

    expect(fs.readFileSync(path.join(dir, 'user-note.md'), 'utf8')).toBe(
      'written by another process'
    )
  })

  it('keeps a successfully provisioned vault when opening it fails', async () => {
    vi.mocked(selectVault).mockResolvedValueOnce({
      success: false,
      vault: null,
      error: 'Unable to open this vault'
    })

    const result = await downloadRemoteVault({
      vaultUuid: 'server-vault-uuid',
      parentPath: parentDir
    })

    expect(result).toMatchObject({ success: false, error: 'Unable to open this vault' })
    const sqlite = new Database(path.join(parentDir, 'my-notes', '.memry', 'data.db'), {
      readonly: true
    })
    try {
      expect(
        sqlite.prepare("SELECT vault_uuid FROM vault_metadata WHERE id = 'singleton'").get()
      ).toEqual({ vault_uuid: 'server-vault-uuid' })
    } finally {
      sqlite.close()
    }
    expect(mockUpsertVault).toHaveBeenCalledWith(
      expect.objectContaining({
        path: path.join(parentDir, 'my-notes'),
        vaultUuid: 'server-vault-uuid'
      })
    )
  })

  it('derives a folder name from the server uuid prefix', () => {
    expect(dormantVaultFolderName('server-vault-uuid-1234')).toBe('memry-vault-server-v')
  })

  it('creates a dormant vault adopting the server uuid without opening it', () => {
    const dir = path.join(parentDir, 'vault-b')

    createDormantVault(dir, 'server-vault-uuid')

    // The data.db was created with the adopted uuid in vault_metadata.
    const dataDbPath = path.join(dir, '.memry', 'data.db')
    expect(fs.existsSync(dataDbPath)).toBe(true)
    const sqlite = new Database(dataDbPath, { readonly: true })
    const row = sqlite
      .prepare<[], { vaultUuid: string }>(
        "SELECT vault_uuid AS vaultUuid FROM vault_metadata WHERE id = 'singleton'"
      )
      .get()
    sqlite.close()
    expect(row?.vaultUuid).toBe('server-vault-uuid')

    // The vault was registered in the store.
    expect(mockUpsertVault).toHaveBeenCalledWith(expect.objectContaining({ path: dir }))
    // And nothing is owed to the CRDT store: a vault provisioned here has no
    // history under a previous uuid for the next open to go looking for.
    expect(mockRecordCrdtStoreRename).not.toHaveBeenCalled()
  })
})
