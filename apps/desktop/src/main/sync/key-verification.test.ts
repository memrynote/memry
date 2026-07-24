import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockRetrieveKey = vi.fn()
const mockGenerateKeyVerifier = vi.fn()
const mockSecureCleanup = vi.fn()
vi.mock('../crypto', () => ({
  retrieveKey: (...args: unknown[]) => mockRetrieveKey(...args),
  generateKeyVerifier: (...args: unknown[]) => mockGenerateKeyVerifier(...args),
  secureCleanup: (...args: unknown[]) => mockSecureCleanup(...args)
}))

const mockStoreGet = vi.fn()
const mockStoreSet = vi.fn()
vi.mock('../store', () => ({
  store: {
    get: (...args: unknown[]) => mockStoreGet(...args),
    set: (...args: unknown[]) => mockStoreSet(...args)
  }
}))

const mockGetFromServer = vi.fn()
vi.mock('./http-client', () => ({
  getFromServer: (...args: unknown[]) => mockGetFromServer(...args)
}))

const mockGetValidAccessToken = vi.fn()
vi.mock('./token-manager', () => ({
  getValidAccessToken: (...args: unknown[]) => mockGetValidAccessToken(...args)
}))

import {
  checkLocalKeyAgainstAccount,
  clearKeyMaterialActivity,
  isKeyMaterialActivityRecent,
  markKeyMaterialActivity,
  persistAccountKeyVerifier,
  resetKeyVerificationForTests
} from './key-verification'

describe('key-verification', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetKeyVerificationForTests()
    mockStoreGet.mockReturnValue({})
    mockRetrieveKey.mockResolvedValue(new Uint8Array(32).fill(1))
    mockGenerateKeyVerifier.mockResolvedValue('local-verifier')
    mockGetValidAccessToken.mockResolvedValue('access-token')
  })

  describe('key material activity window', () => {
    it('reports recent activity after marking, none after reset', () => {
      expect(isKeyMaterialActivityRecent()).toBe(false)
      markKeyMaterialActivity()
      expect(isKeyMaterialActivityRecent()).toBe(true)
      resetKeyVerificationForTests()
      expect(isKeyMaterialActivityRecent()).toBe(false)
    })

    it('clearKeyMaterialActivity lifts the transition hold so checks classify again', async () => {
      markKeyMaterialActivity()
      await expect(checkLocalKeyAgainstAccount()).resolves.toBe('transition')

      clearKeyMaterialActivity()
      expect(isKeyMaterialActivityRecent()).toBe(false)
      mockStoreGet.mockReturnValue({ accountKeyVerifier: 'local-verifier' })
      await expect(checkLocalKeyAgainstAccount()).resolves.toBe('match')
    })
  })

  describe('persistAccountKeyVerifier', () => {
    it('merges the verifier into the sync store group', () => {
      mockStoreGet.mockReturnValue({ email: 'a@b.c' })
      persistAccountKeyVerifier('v-1')
      expect(mockStoreSet).toHaveBeenCalledWith('sync', {
        email: 'a@b.c',
        accountKeyVerifier: 'v-1'
      })
    })
  })

  describe('checkLocalKeyAgainstAccount', () => {
    it('returns match when the local verifier equals the locally stored account verifier (no network)', async () => {
      mockStoreGet.mockReturnValue({ accountKeyVerifier: 'local-verifier' })

      await expect(checkLocalKeyAgainstAccount()).resolves.toBe('match')
      expect(mockGetFromServer).not.toHaveBeenCalled()
      expect(mockSecureCleanup).toHaveBeenCalled()
    })

    it('returns mismatch when the stored account verifier differs', async () => {
      mockStoreGet.mockReturnValue({ accountKeyVerifier: 'other-verifier' })

      await expect(checkLocalKeyAgainstAccount()).resolves.toBe('mismatch')
    })

    it('fetches the verifier from the server when no local copy exists, and caches it', async () => {
      mockGetFromServer.mockResolvedValue({ kdfSalt: 's', keyVerifier: 'server-verifier' })

      await expect(checkLocalKeyAgainstAccount()).resolves.toBe('mismatch')
      expect(mockGetFromServer).toHaveBeenCalledWith('/auth/key-verifier', 'access-token')
      expect(mockStoreSet).toHaveBeenCalledWith(
        'sync',
        expect.objectContaining({ accountKeyVerifier: 'server-verifier' })
      )
    })

    it('returns match when the server verifier equals the local one', async () => {
      mockGetFromServer.mockResolvedValue({ kdfSalt: 's', keyVerifier: 'local-verifier' })

      await expect(checkLocalKeyAgainstAccount()).resolves.toBe('match')
    })

    it('returns unknown when there is no session (no access token)', async () => {
      mockGetValidAccessToken.mockResolvedValue(null)

      await expect(checkLocalKeyAgainstAccount()).resolves.toBe('unknown')
    })

    it('returns unknown when the server fetch fails (offline / older server)', async () => {
      mockGetFromServer.mockRejectedValue(new Error('network down'))

      await expect(checkLocalKeyAgainstAccount()).resolves.toBe('unknown')
    })

    it('returns unknown when the server has no verifier configured', async () => {
      mockGetFromServer.mockResolvedValue({ kdfSalt: 's', keyVerifier: null })

      await expect(checkLocalKeyAgainstAccount()).resolves.toBe('unknown')
    })

    it('returns unknown when no master key is present', async () => {
      mockRetrieveKey.mockResolvedValue(null)

      await expect(checkLocalKeyAgainstAccount()).resolves.toBe('unknown')
    })

    it('returns unknown when the keychain read throws transiently — never classifies an uncertain read', async () => {
      mockStoreGet.mockReturnValue({ accountKeyVerifier: 'other-verifier' })
      mockRetrieveKey.mockRejectedValue(new Error('keychain locked'))

      await expect(checkLocalKeyAgainstAccount()).resolves.toBe('unknown')
    })

    it('returns transition while key material activity is recent (sign-in/recovery/linking mid-flight)', async () => {
      mockStoreGet.mockReturnValue({ accountKeyVerifier: 'other-verifier' })
      markKeyMaterialActivity()

      await expect(checkLocalKeyAgainstAccount()).resolves.toBe('transition')
      expect(mockRetrieveKey).not.toHaveBeenCalled()
    })
  })
})
