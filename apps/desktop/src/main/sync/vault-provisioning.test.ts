import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  recordCrdtStoreRename: mockRecordCrdtStoreRename
}))

vi.mock('../vault', () => ({
  createVaultInfo: mockCreateVaultInfo
}))

import { createDormantVault, dormantVaultFolderName } from './vault-provisioning'

describe('vault-provisioning', () => {
  let parentDir: string

  beforeEach(() => {
    vi.clearAllMocks()
    parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-dormant-'))
  })

  afterEach(() => {
    fs.rmSync(parentDir, { recursive: true, force: true })
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
      .prepare("SELECT vault_uuid AS vaultUuid FROM vault_metadata WHERE id = 'singleton'")
      .get() as { vaultUuid: string } | undefined
    sqlite.close()
    expect(row?.vaultUuid).toBe('server-vault-uuid')

    // The vault was registered in the store.
    expect(mockUpsertVault).toHaveBeenCalledWith(expect.objectContaining({ path: dir }))
    // And nothing is owed to the CRDT store: a vault provisioned here has no
    // history under a previous uuid for the next open to go looking for.
    expect(mockRecordCrdtStoreRename).not.toHaveBeenCalled()
  })
})
