import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  userDataDir: '/userData',
  dataDb: {} as object | null,
  vaultUuid: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
}))

vi.mock('electron', () => ({
  app: { getPath: () => mocks.userDataDir }
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

vi.mock('../database/client', () => ({
  getDatabase: () => mocks.dataDb,
  isDatabaseInitialized: () => mocks.dataDb !== null
}))

vi.mock('../agent/storage/vault-id', () => ({
  getOrCreateVaultUuid: () => mocks.vaultUuid
}))

vi.mock('../store', () => ({
  getLegacyCrdtStoreClaim: () => undefined,
  recordLegacyCrdtStoreClaim: vi.fn()
}))

import { resolveVaultCrdtStore } from './crdt-store-path'

describe('vault CRDT store path', () => {
  beforeEach(() => {
    mocks.dataDb = {}
    mocks.vaultUuid = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
  })

  it('names the directory after the vault uuid', () => {
    expect(resolveVaultCrdtStore()).toEqual({
      vaultUuid: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
      storagePath: '/userData/crdt-stores/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
    })
  })

  it('resolves one directory for a uuid whichever case it comes back in', () => {
    // A linked device adopts the SERVER's uuid, so the casing is not ours to
    // assume. macOS and Windows filesystems are case-insensitive: two casings
    // resolving to two paths would mean one vault with two half-histories.
    mocks.vaultUuid = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'.toUpperCase()
    expect(resolveVaultCrdtStore()?.storagePath).toBe(
      '/userData/crdt-stores/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
    )
  })

  it('hashes an identifier that is not a plain uuid instead of putting it in a path', () => {
    // Nothing local mints this shape, but the value is adopted from the server,
    // and a separator in it would resolve somewhere else entirely.
    mocks.vaultUuid = '../../../etc'
    const storagePath = resolveVaultCrdtStore()?.storagePath ?? ''

    expect(storagePath.startsWith('/userData/crdt-stores/')).toBe(true)
    expect(storagePath).not.toContain('..')
    expect(storagePath).toMatch(/\/crdt-stores\/[0-9a-f]{32}$/)
  })

  it('has no path to resolve while no vault is open', () => {
    mocks.dataDb = null
    expect(resolveVaultCrdtStore()).toBeNull()
  })
})
