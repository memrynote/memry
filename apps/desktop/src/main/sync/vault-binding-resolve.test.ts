import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { VaultBindingState } from '@memry/contracts/ipc-sync-ops'
import type * as BindingModule from './vault-account-binding'

const mocks = vi.hoisted(() => ({
  db: { id: 'db' },
  dbReady: true,
  state: { status: 'bound' } as VaultBindingState,
  userId: 'user-b' as string | null,
  stored: { path: '/v', name: 'V', vaultUuid: 'local-vault' } as Record<string, unknown> | undefined
}))

vi.mock('../database/client', () => ({
  getDatabase: () => mocks.db,
  isDatabaseInitialized: () => mocks.dbReady
}))
vi.mock('../lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))
vi.mock('../store', () => ({
  getCurrentVaultPath: () => '/v',
  findVault: () => mocks.stored,
  upsertVault: vi.fn()
}))
vi.mock('./runtime', () => ({ startSyncRuntime: vi.fn(async () => null) }))
vi.mock('./vault-adoption', () => ({ adoptVaultLocally: vi.fn() }))
vi.mock('./vault-directory', () => ({ refreshVaultDirectory: vi.fn(async () => {}) }))
vi.mock('./vault-account-binding', async (importOriginal) => {
  const actual = await importOriginal<typeof BindingModule>()
  return {
    isChoiceAllowed: actual.isChoiceAllowed,
    getVaultBindingState: () => mocks.state,
    setVaultBindingState: vi.fn((next: VaultBindingState) => {
      mocks.state = next
    }),
    getSignedInUserId: vi.fn(async () => mocks.userId),
    bindVaultForSync: vi.fn(),
    writeVaultAccountBinding: vi.fn()
  }
})

import { upsertVault } from '../store'
import { startSyncRuntime } from './runtime'
import { adoptVaultLocally } from './vault-adoption'
import { refreshVaultDirectory } from './vault-directory'
import { bindVaultForSync, writeVaultAccountBinding } from './vault-account-binding'
import { resolveOpenVaultBinding } from './vault-binding-resolve'

const needsDecision: VaultBindingState = {
  status: 'needs-decision',
  accountVaultCount: 1,
  mergeTarget: { vaultUuid: 'account-vault', name: 'Main' }
}

describe('resolveOpenVaultBinding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.dbReady = true
    mocks.userId = 'user-b'
    mocks.state = needsDecision
  })

  it('keeps the vault local without starting sync', async () => {
    const result = await resolveOpenVaultBinding('local')

    expect(result).toEqual({ success: true, state: { status: 'local-only' } })
    expect(writeVaultAccountBinding).toHaveBeenCalledWith(mocks.db, {
      userId: 'user-b',
      mode: 'local'
    })
    expect(bindVaultForSync).not.toHaveBeenCalled()
    expect(startSyncRuntime).not.toHaveBeenCalled()
  })

  it('adds the vault as its own account vault and starts sync', async () => {
    const result = await resolveOpenVaultBinding('sync')

    expect(result).toEqual({ success: true, state: { status: 'bound' } })
    expect(adoptVaultLocally).not.toHaveBeenCalled()
    expect(bindVaultForSync).toHaveBeenCalledWith(mocks.db, 'user-b')
    expect(startSyncRuntime).toHaveBeenCalled()
    expect(refreshVaultDirectory).toHaveBeenCalledWith({ force: true })
  })

  it('merges into the account vault: adopts its uuid, stamps the store, then binds', async () => {
    await resolveOpenVaultBinding('merge')

    expect(adoptVaultLocally).toHaveBeenCalledWith(mocks.db, 'account-vault')
    expect(upsertVault).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/v', vaultUuid: 'account-vault' })
    )
    expect(bindVaultForSync).toHaveBeenCalledWith(mocks.db, 'user-b')
  })

  it('refuses any choice for another account’s vault', async () => {
    mocks.state = { status: 'foreign' }

    for (const choice of ['sync', 'merge', 'local'] as const) {
      const result = await resolveOpenVaultBinding(choice)
      expect(result.success).toBe(false)
      expect(result.state).toEqual({ status: 'foreign' })
    }
    expect(bindVaultForSync).not.toHaveBeenCalled()
    expect(writeVaultAccountBinding).not.toHaveBeenCalled()
  })

  it('refuses when signed out or no vault is open', async () => {
    mocks.userId = null
    expect((await resolveOpenVaultBinding('sync')).success).toBe(false)

    mocks.userId = 'user-b'
    mocks.dbReady = false
    expect((await resolveOpenVaultBinding('sync')).success).toBe(false)
    expect(bindVaultForSync).not.toHaveBeenCalled()
  })
})
