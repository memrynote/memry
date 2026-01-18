/**
 * Keychain Tests
 *
 * Tests OS keychain storage with mocked keytar.
 *
 * @module main/crypto/keychain.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { KEYCHAIN_KEYS } from '@shared/contracts/crypto'

// Mock keytar before importing the module
vi.mock('keytar', () => ({
  default: {
    setPassword: vi.fn(),
    getPassword: vi.fn(),
    deletePassword: vi.fn(),
    findCredentials: vi.fn()
  }
}))

// Import after mocking
import keytar from 'keytar'
import {
  saveToKeychain,
  getFromKeychain,
  deleteFromKeychain,
  saveMasterKey,
  getMasterKey,
  deleteMasterKey,
  hasMasterKey,
  saveDeviceId,
  getDeviceId,
  saveUserId,
  getUserId,
  saveTokens,
  getTokens,
  deleteTokens,
  clearAllKeychainEntries,
  getStoredKeyNames,
  saveSyncSession,
  getSyncSession,
  hasSyncSession,
  clearSyncSession
} from './keychain'
import {
  TEST_MASTER_KEY,
  TEST_DEVICE_ID,
  TEST_USER_ID,
  TEST_ACCESS_TOKEN,
  TEST_REFRESH_TOKEN
} from './__fixtures__'

const mockedKeytar = vi.mocked(keytar)

describe('keychain', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  describe('saveToKeychain/getFromKeychain/deleteFromKeychain', () => {
    it('should save value to keychain', async () => {
      mockedKeytar.setPassword.mockResolvedValue(undefined)

      await saveToKeychain('test-key', 'test-value')

      expect(mockedKeytar.setPassword).toHaveBeenCalledWith('memry', 'test-key', 'test-value')
    })

    it('should retrieve value from keychain', async () => {
      mockedKeytar.getPassword.mockResolvedValue('test-value')

      const result = await getFromKeychain('test-key')

      expect(mockedKeytar.getPassword).toHaveBeenCalledWith('memry', 'test-key')
      expect(result).toBe('test-value')
    })

    it('should delete value from keychain', async () => {
      mockedKeytar.deletePassword.mockResolvedValue(true)

      const result = await deleteFromKeychain('test-key')

      expect(mockedKeytar.deletePassword).toHaveBeenCalledWith('memry', 'test-key')
      expect(result).toBe(true)
    })

    it('should return null for non-existent key', async () => {
      mockedKeytar.getPassword.mockResolvedValue(null)

      const result = await getFromKeychain('non-existent')

      expect(result).toBeNull()
    })

    it('should use correct service name "memry"', async () => {
      mockedKeytar.setPassword.mockResolvedValue(undefined)
      mockedKeytar.getPassword.mockResolvedValue('value')
      mockedKeytar.deletePassword.mockResolvedValue(true)

      await saveToKeychain('key', 'value')
      await getFromKeychain('key')
      await deleteFromKeychain('key')

      expect(mockedKeytar.setPassword).toHaveBeenCalledWith('memry', 'key', 'value')
      expect(mockedKeytar.getPassword).toHaveBeenCalledWith('memry', 'key')
      expect(mockedKeytar.deletePassword).toHaveBeenCalledWith('memry', 'key')
    })
  })

  describe('saveMasterKey/getMasterKey/deleteMasterKey/hasMasterKey', () => {
    it('should save master key as Base64', async () => {
      mockedKeytar.setPassword.mockResolvedValue(undefined)

      await saveMasterKey(TEST_MASTER_KEY)

      const expectedBase64 = TEST_MASTER_KEY.toString('base64')
      expect(mockedKeytar.setPassword).toHaveBeenCalledWith(
        'memry',
        KEYCHAIN_KEYS.MASTER_KEY,
        expectedBase64
      )
    })

    it('should retrieve master key as Buffer', async () => {
      const base64 = TEST_MASTER_KEY.toString('base64')
      mockedKeytar.getPassword.mockResolvedValue(base64)

      const result = await getMasterKey()

      expect(result).toBeInstanceOf(Buffer)
      expect(result?.length).toBe(32)
      expect(result?.equals(TEST_MASTER_KEY)).toBe(true)
    })

    it('should delete master key', async () => {
      mockedKeytar.deletePassword.mockResolvedValue(true)

      const result = await deleteMasterKey()

      expect(mockedKeytar.deletePassword).toHaveBeenCalledWith('memry', KEYCHAIN_KEYS.MASTER_KEY)
      expect(result).toBe(true)
    })

    it('should return true if master key exists', async () => {
      mockedKeytar.getPassword.mockResolvedValue('some-base64-key')

      const result = await hasMasterKey()

      expect(result).toBe(true)
    })

    it('should return false if master key does not exist', async () => {
      mockedKeytar.getPassword.mockResolvedValue(null)

      const result = await hasMasterKey()

      expect(result).toBe(false)
    })

    it('should return null if no master key', async () => {
      mockedKeytar.getPassword.mockResolvedValue(null)

      const result = await getMasterKey()

      expect(result).toBeNull()
    })

    it('should handle Uint8Array input', async () => {
      mockedKeytar.setPassword.mockResolvedValue(undefined)

      const uint8Array = new Uint8Array(TEST_MASTER_KEY)
      await saveMasterKey(uint8Array)

      const expectedBase64 = Buffer.from(uint8Array).toString('base64')
      expect(mockedKeytar.setPassword).toHaveBeenCalledWith(
        'memry',
        KEYCHAIN_KEYS.MASTER_KEY,
        expectedBase64
      )
    })
  })

  describe('saveDeviceId/getDeviceId', () => {
    it('should save and retrieve device ID', async () => {
      mockedKeytar.setPassword.mockResolvedValue(undefined)
      mockedKeytar.getPassword.mockResolvedValue(TEST_DEVICE_ID)

      await saveDeviceId(TEST_DEVICE_ID)
      const result = await getDeviceId()

      expect(mockedKeytar.setPassword).toHaveBeenCalledWith(
        'memry',
        KEYCHAIN_KEYS.DEVICE_ID,
        TEST_DEVICE_ID
      )
      expect(result).toBe(TEST_DEVICE_ID)
    })

    it('should return null for missing device ID', async () => {
      mockedKeytar.getPassword.mockResolvedValue(null)

      const result = await getDeviceId()

      expect(result).toBeNull()
    })
  })

  describe('saveUserId/getUserId', () => {
    it('should save and retrieve user ID', async () => {
      mockedKeytar.setPassword.mockResolvedValue(undefined)
      mockedKeytar.getPassword.mockResolvedValue(TEST_USER_ID)

      await saveUserId(TEST_USER_ID)
      const result = await getUserId()

      expect(mockedKeytar.setPassword).toHaveBeenCalledWith(
        'memry',
        KEYCHAIN_KEYS.USER_ID,
        TEST_USER_ID
      )
      expect(result).toBe(TEST_USER_ID)
    })

    it('should return null for missing user ID', async () => {
      mockedKeytar.getPassword.mockResolvedValue(null)

      const result = await getUserId()

      expect(result).toBeNull()
    })
  })

  describe('saveTokens/getTokens/deleteTokens', () => {
    it('should save access and refresh tokens', async () => {
      mockedKeytar.setPassword.mockResolvedValue(undefined)

      await saveTokens(TEST_ACCESS_TOKEN, TEST_REFRESH_TOKEN)

      expect(mockedKeytar.setPassword).toHaveBeenCalledTimes(2)
      expect(mockedKeytar.setPassword).toHaveBeenCalledWith(
        'memry',
        KEYCHAIN_KEYS.ACCESS_TOKEN,
        TEST_ACCESS_TOKEN
      )
      expect(mockedKeytar.setPassword).toHaveBeenCalledWith(
        'memry',
        KEYCHAIN_KEYS.REFRESH_TOKEN,
        TEST_REFRESH_TOKEN
      )
    })

    it('should retrieve tokens object', async () => {
      mockedKeytar.getPassword.mockImplementation(async (_service, key) => {
        if (key === KEYCHAIN_KEYS.ACCESS_TOKEN) return TEST_ACCESS_TOKEN
        if (key === KEYCHAIN_KEYS.REFRESH_TOKEN) return TEST_REFRESH_TOKEN
        return null
      })

      const result = await getTokens()

      expect(result).toEqual({
        accessToken: TEST_ACCESS_TOKEN,
        refreshToken: TEST_REFRESH_TOKEN
      })
    })

    it('should delete tokens', async () => {
      mockedKeytar.deletePassword.mockResolvedValue(true)

      await deleteTokens()

      expect(mockedKeytar.deletePassword).toHaveBeenCalledTimes(2)
      expect(mockedKeytar.deletePassword).toHaveBeenCalledWith('memry', KEYCHAIN_KEYS.ACCESS_TOKEN)
      expect(mockedKeytar.deletePassword).toHaveBeenCalledWith('memry', KEYCHAIN_KEYS.REFRESH_TOKEN)
    })

    it('should return null if tokens not found', async () => {
      mockedKeytar.getPassword.mockResolvedValue(null)

      const result = await getTokens()

      expect(result).toBeNull()
    })

    it('should return null if only access token exists', async () => {
      mockedKeytar.getPassword.mockImplementation(async (_service, key) => {
        if (key === KEYCHAIN_KEYS.ACCESS_TOKEN) return TEST_ACCESS_TOKEN
        return null
      })

      const result = await getTokens()

      expect(result).toBeNull()
    })

    it('should return null if only refresh token exists', async () => {
      mockedKeytar.getPassword.mockImplementation(async (_service, key) => {
        if (key === KEYCHAIN_KEYS.REFRESH_TOKEN) return TEST_REFRESH_TOKEN
        return null
      })

      const result = await getTokens()

      expect(result).toBeNull()
    })
  })

  describe('clearAllKeychainEntries', () => {
    it('should delete all known keys', async () => {
      mockedKeytar.deletePassword.mockResolvedValue(true)

      await clearAllKeychainEntries()

      // Should delete all keys in KEYCHAIN_KEYS
      const allKeys = Object.values(KEYCHAIN_KEYS)
      expect(mockedKeytar.deletePassword).toHaveBeenCalledTimes(allKeys.length)

      for (const key of allKeys) {
        expect(mockedKeytar.deletePassword).toHaveBeenCalledWith('memry', key)
      }
    })
  })

  describe('getStoredKeyNames', () => {
    it('should return list of stored keys', async () => {
      mockedKeytar.getPassword.mockImplementation(async (_service, key) => {
        // Only master-key and device-id are stored
        if (key === KEYCHAIN_KEYS.MASTER_KEY) return 'some-value'
        if (key === KEYCHAIN_KEYS.DEVICE_ID) return 'some-value'
        return null
      })

      const result = await getStoredKeyNames()

      expect(result).toContain(KEYCHAIN_KEYS.MASTER_KEY)
      expect(result).toContain(KEYCHAIN_KEYS.DEVICE_ID)
      expect(result).not.toContain(KEYCHAIN_KEYS.USER_ID)
    })

    it('should return empty array if no keys stored', async () => {
      mockedKeytar.getPassword.mockResolvedValue(null)

      const result = await getStoredKeyNames()

      expect(result).toEqual([])
    })
  })

  describe('saveSyncSession/getSyncSession/hasSyncSession/clearSyncSession', () => {
    const testSession = {
      userId: TEST_USER_ID,
      deviceId: TEST_DEVICE_ID,
      accessToken: TEST_ACCESS_TOKEN,
      refreshToken: TEST_REFRESH_TOKEN,
      masterKey: TEST_MASTER_KEY
    }

    it('should save complete sync session', async () => {
      mockedKeytar.setPassword.mockResolvedValue(undefined)

      await saveSyncSession(testSession)

      // Should save all session components
      expect(mockedKeytar.setPassword).toHaveBeenCalledWith(
        'memry',
        KEYCHAIN_KEYS.USER_ID,
        TEST_USER_ID
      )
      expect(mockedKeytar.setPassword).toHaveBeenCalledWith(
        'memry',
        KEYCHAIN_KEYS.DEVICE_ID,
        TEST_DEVICE_ID
      )
      expect(mockedKeytar.setPassword).toHaveBeenCalledWith(
        'memry',
        KEYCHAIN_KEYS.ACCESS_TOKEN,
        TEST_ACCESS_TOKEN
      )
      expect(mockedKeytar.setPassword).toHaveBeenCalledWith(
        'memry',
        KEYCHAIN_KEYS.REFRESH_TOKEN,
        TEST_REFRESH_TOKEN
      )
      expect(mockedKeytar.setPassword).toHaveBeenCalledWith(
        'memry',
        KEYCHAIN_KEYS.MASTER_KEY,
        TEST_MASTER_KEY.toString('base64')
      )
    })

    it('should retrieve complete sync session', async () => {
      mockedKeytar.getPassword.mockImplementation(async (_service, key) => {
        switch (key) {
          case KEYCHAIN_KEYS.USER_ID:
            return TEST_USER_ID
          case KEYCHAIN_KEYS.DEVICE_ID:
            return TEST_DEVICE_ID
          case KEYCHAIN_KEYS.ACCESS_TOKEN:
            return TEST_ACCESS_TOKEN
          case KEYCHAIN_KEYS.REFRESH_TOKEN:
            return TEST_REFRESH_TOKEN
          case KEYCHAIN_KEYS.MASTER_KEY:
            return TEST_MASTER_KEY.toString('base64')
          default:
            return null
        }
      })

      const result = await getSyncSession()

      expect(result).not.toBeNull()
      expect(result?.userId).toBe(TEST_USER_ID)
      expect(result?.deviceId).toBe(TEST_DEVICE_ID)
      expect(result?.accessToken).toBe(TEST_ACCESS_TOKEN)
      expect(result?.refreshToken).toBe(TEST_REFRESH_TOKEN)
      expect(result?.masterKey.equals(TEST_MASTER_KEY)).toBe(true)
    })

    it('should return true if session exists', async () => {
      mockedKeytar.getPassword.mockImplementation(async (_service, key) => {
        switch (key) {
          case KEYCHAIN_KEYS.USER_ID:
            return TEST_USER_ID
          case KEYCHAIN_KEYS.DEVICE_ID:
            return TEST_DEVICE_ID
          case KEYCHAIN_KEYS.ACCESS_TOKEN:
            return TEST_ACCESS_TOKEN
          case KEYCHAIN_KEYS.REFRESH_TOKEN:
            return TEST_REFRESH_TOKEN
          case KEYCHAIN_KEYS.MASTER_KEY:
            return TEST_MASTER_KEY.toString('base64')
          default:
            return null
        }
      })

      const result = await hasSyncSession()

      expect(result).toBe(true)
    })

    it('should return false if session incomplete', async () => {
      mockedKeytar.getPassword.mockImplementation(async (_service, key) => {
        // Only return user ID, missing others
        if (key === KEYCHAIN_KEYS.USER_ID) return TEST_USER_ID
        return null
      })

      const result = await hasSyncSession()

      expect(result).toBe(false)
    })

    it('should clear all session data', async () => {
      mockedKeytar.deletePassword.mockResolvedValue(true)

      await clearSyncSession()

      // Should call clearAllKeychainEntries
      const allKeys = Object.values(KEYCHAIN_KEYS)
      expect(mockedKeytar.deletePassword).toHaveBeenCalledTimes(allKeys.length)
    })

    it('should return null for incomplete session (missing master key)', async () => {
      mockedKeytar.getPassword.mockImplementation(async (_service, key) => {
        switch (key) {
          case KEYCHAIN_KEYS.USER_ID:
            return TEST_USER_ID
          case KEYCHAIN_KEYS.DEVICE_ID:
            return TEST_DEVICE_ID
          case KEYCHAIN_KEYS.ACCESS_TOKEN:
            return TEST_ACCESS_TOKEN
          case KEYCHAIN_KEYS.REFRESH_TOKEN:
            return TEST_REFRESH_TOKEN
          // MASTER_KEY is missing
          default:
            return null
        }
      })

      const result = await getSyncSession()

      expect(result).toBeNull()
    })

    it('should return null for incomplete session (missing tokens)', async () => {
      mockedKeytar.getPassword.mockImplementation(async (_service, key) => {
        switch (key) {
          case KEYCHAIN_KEYS.USER_ID:
            return TEST_USER_ID
          case KEYCHAIN_KEYS.DEVICE_ID:
            return TEST_DEVICE_ID
          case KEYCHAIN_KEYS.MASTER_KEY:
            return TEST_MASTER_KEY.toString('base64')
          // Tokens are missing
          default:
            return null
        }
      })

      const result = await getSyncSession()

      expect(result).toBeNull()
    })
  })
})
