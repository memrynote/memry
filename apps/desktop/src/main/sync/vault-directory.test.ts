import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'

import { encryptVaultName } from './vault-name-crypto'

vi.mock('./http-client', () => ({
  getFromServer: vi.fn(),
  postToServer: vi.fn(async () => ({ success: true }))
}))

vi.mock('./token-manager', () => ({
  retrieveToken: vi.fn(async () => 'access-token')
}))

vi.mock('../crypto', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  retrieveKey: vi.fn(async () => new Uint8Array(32).fill(1))
}))

vi.mock('../crypto/keys', () => ({
  // Fresh copy per call: callers secureCleanup() the derived key after use
  deriveKey: vi.fn(async () => new Uint8Array(32).fill(7))
}))

vi.mock('../store', () => ({
  getVaults: vi.fn(() => []),
  getCurrentVaultPath: vi.fn(() => null),
  getAccountVaultsCache: vi.fn(() => undefined),
  setAccountVaultsCache: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/memry-test-docs') }
}))

vi.mock('../vault', () => ({
  selectVault: vi.fn(async (input: { path?: string }) => ({
    success: true,
    vault: { path: input.path },
    error: undefined
  }))
}))

vi.mock('./vault-provisioning', () => ({
  createDormantVault: vi.fn()
}))

import { getFromServer, postToServer } from './http-client'
import { retrieveToken } from './token-manager'
import {
  getAccountVaultsCache,
  getCurrentVaultPath,
  getVaults,
  setAccountVaultsCache
} from '../store'
import { selectVault } from '../vault'
import { createDormantVault } from './vault-provisioning'
import {
  __resetThrottleForTests,
  downloadRemoteVault,
  listAccountVaults,
  refreshVaultDirectory,
  suggestVaultFolder
} from './vault-directory'

const NAME_KEY = new Uint8Array(32).fill(7)

function serverVault(
  vaultUuid: string,
  name: string | null,
  itemCount = 0
): Record<string, unknown> {
  if (name === null) {
    return { vaultUuid, itemCount, createdAt: 1000, encryptedName: null, nameNonce: null }
  }
  const { encryptedName, nameNonce } = encryptVaultName(name, NAME_KEY, vaultUuid)
  return { vaultUuid, itemCount, createdAt: 1000, encryptedName, nameNonce }
}

describe('vault-directory', () => {
  beforeAll(async () => {
    await sodium.ready
  })

  beforeEach(() => {
    vi.clearAllMocks()
    __resetThrottleForTests()
  })

  describe('refreshVaultDirectory', () => {
    it('fetches the account vault list, decrypts names, and caches it', async () => {
      vi.mocked(getFromServer).mockResolvedValueOnce({
        vaults: [serverVault('uuid-a', 'Alpha', 12)]
      })

      await refreshVaultDirectory({ force: true })

      expect(getFromServer).toHaveBeenCalledWith('/sync/vaults', 'access-token')
      expect(setAccountVaultsCache).toHaveBeenCalledWith({
        fetchedAt: expect.any(Number),
        vaults: [{ vaultUuid: 'uuid-a', name: 'Alpha', itemCount: 12, createdAt: 1000 }]
      })
    })

    it('caches name: null when the name cannot be decrypted', async () => {
      vi.mocked(getFromServer).mockResolvedValueOnce({
        vaults: [
          {
            vaultUuid: 'uuid-x',
            itemCount: 1,
            createdAt: 1000,
            encryptedName: 'garbage',
            nameNonce: 'garbage'
          }
        ]
      })

      await refreshVaultDirectory({ force: true })

      expect(setAccountVaultsCache).toHaveBeenCalledWith({
        fetchedAt: expect.any(Number),
        vaults: [{ vaultUuid: 'uuid-x', name: null, itemCount: 1, createdAt: 1000 }]
      })
    })

    it('self-registers local vaults missing from the server list', async () => {
      vi.mocked(getFromServer).mockResolvedValueOnce({ vaults: [] })
      vi.mocked(getVaults).mockReturnValue([
        {
          path: '/v/alpha',
          name: 'Alpha',
          noteCount: 0,
          taskCount: 0,
          lastOpened: '',
          isDefault: false,
          vaultUuid: 'uuid-a'
        },
        // no uuid yet — must be skipped
        { path: '/v/beta', name: 'Beta', noteCount: 0, taskCount: 0, lastOpened: '', isDefault: false }
      ])

      await refreshVaultDirectory({ force: true })

      expect(postToServer).toHaveBeenCalledTimes(1)
      expect(postToServer).toHaveBeenCalledWith(
        '/sync/vaults',
        expect.objectContaining({ vaultUuid: 'uuid-a' }),
        'access-token'
      )
    })

    it('re-registers when the server name differs from the local name', async () => {
      vi.mocked(getFromServer).mockResolvedValueOnce({
        vaults: [serverVault('uuid-a', 'Old Name', 3)]
      })
      vi.mocked(getVaults).mockReturnValue([
        {
          path: '/v/alpha',
          name: 'New Name',
          noteCount: 0,
          taskCount: 0,
          lastOpened: '',
          isDefault: false,
          vaultUuid: 'uuid-a'
        }
      ])

      await refreshVaultDirectory({ force: true })

      expect(postToServer).toHaveBeenCalledWith(
        '/sync/vaults',
        expect.objectContaining({ vaultUuid: 'uuid-a' }),
        'access-token'
      )
    })

    it('does not re-register when names match', async () => {
      vi.mocked(getFromServer).mockResolvedValueOnce({
        vaults: [serverVault('uuid-a', 'Alpha', 3)]
      })
      vi.mocked(getVaults).mockReturnValue([
        {
          path: '/v/alpha',
          name: 'Alpha',
          noteCount: 0,
          taskCount: 0,
          lastOpened: '',
          isDefault: false,
          vaultUuid: 'uuid-a'
        }
      ])

      await refreshVaultDirectory({ force: true })

      expect(postToServer).not.toHaveBeenCalled()
    })

    it('throttles non-forced refreshes', async () => {
      vi.mocked(getFromServer).mockResolvedValue({ vaults: [] })

      await refreshVaultDirectory({ force: true })
      await refreshVaultDirectory()

      expect(getFromServer).toHaveBeenCalledTimes(1)
    })

    it('is a silent no-op without an access token', async () => {
      vi.mocked(retrieveToken).mockResolvedValueOnce(null)

      await refreshVaultDirectory({ force: true })

      expect(getFromServer).not.toHaveBeenCalled()
      expect(setAccountVaultsCache).not.toHaveBeenCalled()
    })
  })

  describe('listAccountVaults', () => {
    it('merges the cache with the local registry by uuid', () => {
      vi.mocked(getAccountVaultsCache).mockReturnValue({
        fetchedAt: 1,
        vaults: [
          { vaultUuid: 'uuid-a', name: 'Alpha', itemCount: 12, createdAt: 1000 },
          { vaultUuid: 'uuid-b', name: 'Beta', itemCount: 4, createdAt: 2000 }
        ]
      })
      vi.mocked(getVaults).mockReturnValue([
        {
          path: '/v/alpha',
          name: 'Alpha',
          noteCount: 0,
          taskCount: 0,
          lastOpened: '',
          isDefault: false,
          vaultUuid: 'uuid-a'
        }
      ])

      const result = listAccountVaults()

      expect(result).toHaveLength(2)
      expect(result[0]).toMatchObject({ vaultUuid: 'uuid-a', localPath: '/v/alpha' })
      expect(result[1]).toMatchObject({
        vaultUuid: 'uuid-b',
        name: 'Beta',
        localPath: null
      })
      expect(result[1].suggestedPath).toContain('beta')
    })

    it('returns empty when there is no cache', () => {
      vi.mocked(getAccountVaultsCache).mockReturnValue(undefined)
      expect(listAccountVaults()).toEqual([])
    })
  })

  describe('suggestVaultFolder', () => {
    it('slugifies the name under the parent dir', () => {
      expect(suggestVaultFolder({ vaultUuid: 'uuid-1234567890', name: 'My Vault!' }, '/parent')).toBe(
        '/parent/my-vault'
      )
    })

    it('falls back to a uuid-based folder name without a name', () => {
      expect(suggestVaultFolder({ vaultUuid: 'abcdefgh-rest', name: null }, '/parent')).toBe(
        '/parent/memry-vault-abcdefgh'
      )
    })
  })

  describe('downloadRemoteVault', () => {
    it('switches to the existing local copy when already downloaded', async () => {
      vi.mocked(getVaults).mockReturnValue([
        {
          path: '/v/alpha',
          name: 'Alpha',
          noteCount: 0,
          taskCount: 0,
          lastOpened: '',
          isDefault: false,
          vaultUuid: 'uuid-a'
        }
      ])

      const result = await downloadRemoteVault({ vaultUuid: 'uuid-a' })

      expect(createDormantVault).not.toHaveBeenCalled()
      expect(selectVault).toHaveBeenCalledWith({ path: '/v/alpha' })
      expect(result.success).toBe(true)
    })

    it('provisions a dormant vault then opens it', async () => {
      vi.mocked(getVaults).mockReturnValue([])
      vi.mocked(getAccountVaultsCache).mockReturnValue({
        fetchedAt: 1,
        vaults: [{ vaultUuid: 'uuid-b', name: 'Beta', itemCount: 4, createdAt: 2000 }]
      })

      const parent = '/tmp/__memry-vd-test__'
      const result = await downloadRemoteVault({ vaultUuid: 'uuid-b', parentPath: parent })

      expect(createDormantVault).toHaveBeenCalledWith(`${parent}/beta`, 'uuid-b')
      expect(selectVault).toHaveBeenCalledWith({ path: `${parent}/beta` })
      expect(result.success).toBe(true)
    })
  })
})
