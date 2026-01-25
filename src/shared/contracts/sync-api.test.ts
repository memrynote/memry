import { describe, it, expect } from 'vitest'
import {
  SyncItemSchema,
  SyncItemPushSchema,
  SyncItemResponseSchema,
  UserSchema,
  DeviceSchema,
  PushSyncRequestSchema,
  PullSyncRequestSchema,
  PullSyncResponseSchema,
  SYNC_ITEM_TYPES,
  SYNC_OPERATIONS,
  SYNC_STATUS,
  DEVICE_PLATFORMS,
  AUTH_METHODS,
  AUTH_PROVIDERS,
  LINKING_SESSION_STATUS,
  validateSyncItem,
  validateSyncItemPush,
  validatePushRequest,
  validatePullRequest,
  VectorClockSchema
} from '@shared/contracts/sync-api'
import {
  emptyClock,
  incrementClock,
  mergeClock,
  compareClock,
  clockDominates
} from '@shared/contracts/crypto'

describe('Sync API Contracts', () => {
  describe('Constants', () => {
    it('should have all sync item types', () => {
      expect(SYNC_ITEM_TYPES).toEqual([
        'task',
        'note',
        'inbox',
        'filter',
        'project',
        'settings',
        'journal'
      ])
    })

    it('should have all sync operations', () => {
      expect(SYNC_OPERATIONS).toEqual(['create', 'update', 'delete'])
    })

    it('should have all sync status values', () => {
      expect(SYNC_STATUS).toEqual(['idle', 'syncing', 'offline', 'error', 'paused'])
    })

    it('should have all device platforms', () => {
      expect(DEVICE_PLATFORMS).toEqual(['macos', 'windows', 'linux', 'ios', 'android', 'unknown'])
    })

    it('should have all auth methods', () => {
      expect(AUTH_METHODS).toEqual(['email', 'oauth'])
    })

    it('should have all auth providers', () => {
      expect(AUTH_PROVIDERS).toEqual(['google'])
    })

    it('should have all linking session statuses', () => {
      expect(LINKING_SESSION_STATUS).toEqual([
        'pending',
        'scanned',
        'approved',
        'completed',
        'expired'
      ])
    })
  })

  describe('VectorClockSchema', () => {
    it('should validate empty vector clock', () => {
      const result = VectorClockSchema.parse({})
      expect(result).toEqual({})
    })

    it('should validate vector clock with values', () => {
      const clock = { device1: 5, device2: 3 }
      const result = VectorClockSchema.parse(clock)
      expect(result).toEqual(clock)
    })

    it('should reject non-integer values', () => {
      expect(() => VectorClockSchema.parse({ device1: 1.5 })).toThrow()
    })

    it('should reject negative values', () => {
      expect(() => VectorClockSchema.parse({ device1: -1 })).toThrow()
    })
  })

  describe('SyncItemSchema', () => {
    const validItem = {
      item_type: 'note' as const,
      item_id: '123e4567-e89b-12d3-a456-426614174000',
      user_id: '123e4567-e89b-12d3-a456-426614174001',
      encrypted_data: 'SGVsbG8gV29ybGQ=', // Base64
      encrypted_key: 'SGVsbG8gV29ybGQ=',
      key_nonce: 'SGVsbG8gV29ybGQ=',
      data_nonce: 'SGVsbG8gV29ybGQ=',
      deleted: false,
      crypto_version: 1,
      size_bytes: 1024,
      content_hash: 'a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3',
      signer_device_id: '123e4567-e89b-12d3-a456-426614174002',
      signature: 'SGVsbG8gV29ybGQ=',
      server_cursor: 12345,
      created_at: Date.now(),
      updated_at: Date.now()
    }

    it('should validate valid sync item', () => {
      const result = SyncItemSchema.parse(validItem)
      expect(result.item_type).toBe('note')
      expect(result.item_id).toBe(validItem.item_id)
    })

    it('should reject invalid item type', () => {
      const invalid = { ...validItem, item_type: 'invalid' as any }
      expect(() => SyncItemSchema.parse(invalid)).toThrow()
    })

    it('should reject invalid item id', () => {
      const invalid = { ...validItem, item_id: '' }
      expect(() => SyncItemSchema.parse(invalid)).toThrow()
    })

    it('should reject invalid Base64', () => {
      const invalid = { ...validItem, encrypted_data: 'invalid-base64!' }
      expect(() => SyncItemSchema.parse(invalid)).toThrow()
    })

    it('should reject invalid content hash length', () => {
      const invalid = { ...validItem, content_hash: 'short' }
      expect(() => SyncItemSchema.parse(invalid)).toThrow()
    })
  })

  describe('SyncItemPushSchema', () => {
    const validPushItem = {
      itemType: 'note' as const,
      itemId: 'note-1',
      encryptedData: 'SGVsbG8gV29ybGQ=',
      encryptedKey: 'SGVsbG8gV29ybGQ=',
      keyNonce: 'SGVsbG8gV29ybGQ=',
      dataNonce: 'SGVsbG8gV29ybGQ=',
      deleted: false,
      cryptoVersion: 1,
      sizeBytes: 1024,
      contentHash: 'a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3',
      signerDeviceId: '123e4567-e89b-12d3-a456-426614174002',
      signature: 'SGVsbG8gV29ybGQ='
    }

    it('should validate valid push item', () => {
      const result = SyncItemPushSchema.parse(validPushItem)
      expect(result.itemType).toBe('note')
    })

    it('should validate with optional clock', () => {
      const withClock = { ...validPushItem, clock: { device1: 5 } }
      const result = SyncItemPushSchema.parse(withClock)
      expect(result.clock).toEqual({ device1: 5 })
    })

    it('should reject invalid item type', () => {
      const invalid = { ...validPushItem, itemType: 'invalid' as any }
      expect(() => SyncItemPushSchema.parse(invalid)).toThrow()
    })
  })

  describe('SyncItemResponseSchema', () => {
    const validResponseItem = {
      itemType: 'note' as const,
      itemId: 'note-1',
      userId: '123e4567-e89b-12d3-a456-426614174001',
      encryptedData: 'SGVsbG8gV29ybGQ=',
      encryptedKey: 'SGVsbG8gV29ybGQ=',
      keyNonce: 'SGVsbG8gV29ybGQ=',
      dataNonce: 'SGVsbG8gV29ybGQ=',
      deleted: false,
      cryptoVersion: 1,
      sizeBytes: 1024,
      contentHash: 'a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3',
      signerDeviceId: '123e4567-e89b-12d3-a456-426614174002',
      signature: 'SGVsbG8gV29ybGQ=',
      serverCursor: 12345,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }

    it('should validate valid response item', () => {
      const result = SyncItemResponseSchema.parse(validResponseItem)
      expect(result.itemType).toBe('note')
      expect(result.serverCursor).toBe(12345)
    })

    it('should reject missing server fields', () => {
      const invalid = { ...validResponseItem }
      delete (invalid as any).serverCursor
      expect(() => SyncItemResponseSchema.parse(invalid)).toThrow()
    })
  })

  describe('UserSchema', () => {
    const validUser = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      email: 'test@example.com',
      emailVerified: true,
      authMethod: 'email' as const,
      storageUsed: 0,
      storageLimit: 1073741824, // 1GB
      createdAt: Date.now(),
      updatedAt: Date.now()
    }

    it('should validate valid user', () => {
      const result = UserSchema.parse(validUser)
      expect(result.email).toBe('test@example.com')
    })

    it('should validate OAuth user', () => {
      const oauthUser = {
        ...validUser,
        authMethod: 'oauth' as const,
        authProvider: 'google' as const,
        authProviderId: 'google-user-123'
      }
      const result = UserSchema.parse(oauthUser)
      expect(result.authProvider).toBe('google')
    })

    it('should reject invalid email', () => {
      const invalid = { ...validUser, email: 'not-an-email' }
      expect(() => UserSchema.parse(invalid)).toThrow()
    })
  })

  describe('DeviceSchema', () => {
    const validDevice = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      name: 'My MacBook',
      platform: 'macos' as const,
      osVersion: '14.0',
      appVersion: '1.0.0',
      authPublicKey: 'SGVsbG8gV29ybGQ=',
      linkedAt: Date.now(),
      lastSyncAt: Date.now()
    }

    it('should validate valid device', () => {
      const result = DeviceSchema.parse(validDevice)
      expect(result.name).toBe('My MacBook')
    })

    it('should validate without lastSyncAt', () => {
      const withoutSync = { ...validDevice, lastSyncAt: undefined }
      const result = DeviceSchema.parse(withoutSync)
      expect(result.lastSyncAt).toBeUndefined()
    })

    it('should reject invalid platform', () => {
      const invalid = { ...validDevice, platform: 'invalid' as any }
      expect(() => DeviceSchema.parse(invalid)).toThrow()
    })
  })

  describe('Validation Functions', () => {
    const validResponseItem = {
      itemType: 'note' as const,
      itemId: 'note-1',
      userId: '123e4567-e89b-12d3-a456-426614174001',
      encryptedData: 'SGVsbG8gV29ybGQ=',
      encryptedKey: 'SGVsbG8gV29ybGQ=',
      keyNonce: 'SGVsbG8gV29ybGQ=',
      dataNonce: 'SGVsbG8gV29ybGQ=',
      deleted: false,
      cryptoVersion: 1,
      sizeBytes: 1024,
      contentHash: 'a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3',
      signerDeviceId: '123e4567-e89b-12d3-a456-426614174002',
      signature: 'SGVsbG8gV29ybGQ=',
      serverCursor: 12345,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }

    const validPushItem = {
      itemType: 'note' as const,
      itemId: 'note-1',
      encryptedData: 'SGVsbG8gV29ybGQ=',
      encryptedKey: 'SGVsbG8gV29ybGQ=',
      keyNonce: 'SGVsbG8gV29ybGQ=',
      dataNonce: 'SGVsbG8gV29ybGQ=',
      deleted: false,
      cryptoVersion: 1,
      sizeBytes: 1024,
      contentHash: 'a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3',
      signerDeviceId: '123e4567-e89b-12d3-a456-426614174002',
      signature: 'SGVsbG8gV29ybGQ='
    }

    it('validateSyncItem should accept valid item', () => {
      const result = validateSyncItem(validResponseItem)
      expect(result.itemType).toBe('note')
    })

    it('validateSyncItem should reject invalid item', () => {
      const invalid = { ...validResponseItem, itemType: 'invalid' as any }
      expect(() => validateSyncItem(invalid)).toThrow()
    })

    it('validateSyncItemPush should accept valid push item', () => {
      const result = validateSyncItemPush(validPushItem)
      expect(result.itemType).toBe('note')
    })

    it('validatePushRequest should validate push request', () => {
      const request = {
        items: [validPushItem],
        deviceClock: { device1: 5 }
      }
      const result = validatePushRequest(request)
      expect(result.items).toHaveLength(1)
    })

    it('validatePullRequest should validate pull request', () => {
      const request = { cursor: 12345, limit: 50 }
      const result = validatePullRequest(request)
      expect(result.cursor).toBe(12345)
    })
  })

  describe('Vector Clock Helpers', () => {
    it('emptyClock should return empty object', () => {
      expect(emptyClock()).toEqual({})
    })

    it('incrementClock should increment device counter', () => {
      const clock = { device1: 5, device2: 3 }
      const result = incrementClock(clock, 'device1')
      expect(result).toEqual({ device1: 6, device2: 3 })
    })

    it('incrementClock should add new device', () => {
      const clock = { device1: 5 }
      const result = incrementClock(clock, 'device2')
      expect(result).toEqual({ device1: 5, device2: 1 })
    })

    it('mergeClock should take maximum values', () => {
      const a = { device1: 5, device2: 3 }
      const b = { device1: 3, device2: 7, device3: 2 }
      const result = mergeClock(a, b)
      expect(result).toEqual({ device1: 5, device2: 7, device3: 2 })
    })

    it('compareClock should return 1 when a dominates', () => {
      const a = { device1: 5, device2: 3 }
      const b = { device1: 3, device2: 3 }
      expect(compareClock(a, b)).toBe(1)
    })

    it('compareClock should return -1 when b dominates', () => {
      const a = { device1: 3, device2: 3 }
      const b = { device1: 5, device2: 3 }
      expect(compareClock(a, b)).toBe(-1)
    })

    it('compareClock should return 0 for concurrent clocks', () => {
      const a = { device1: 5, device2: 3 }
      const b = { device1: 3, device2: 7 }
      expect(compareClock(a, b)).toBe(0)
    })

    it('clockDominates should return true when a dominates b', () => {
      const a = { device1: 5, device2: 3 }
      const b = { device1: 3, device2: 3 }
      expect(clockDominates(a, b)).toBe(true)
    })

    it('clockDominates should return false when a does not dominate b', () => {
      const a = { device1: 5, device2: 3 }
      const b = { device1: 3, device2: 7 }
      expect(clockDominates(a, b)).toBe(false)
    })
  })

  describe('API Schemas', () => {
    it('PushSyncRequestSchema should validate valid request', () => {
      const request = {
        items: [
          {
            itemType: 'note' as const,
            itemId: 'note-1',
            encryptedData: 'SGVsbG8gV29ybGQ=',
            encryptedKey: 'SGVsbG8gV29ybGQ=',
            keyNonce: 'SGVsbG8gV29ybGQ=',
            dataNonce: 'SGVsbG8gV29ybGQ=',
            deleted: false,
            cryptoVersion: 1,
            sizeBytes: 1024,
            contentHash: 'a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3',
            signerDeviceId: '123e4567-e89b-12d3-a456-426614174002',
            signature: 'SGVsbG8gV29ybGQ='
          }
        ],
        deviceClock: { device1: 5 }
      }
      const result = PushSyncRequestSchema.parse(request)
      expect(result.items).toHaveLength(1)
    })

    it('PullSyncRequestSchema should validate valid request', () => {
      const request = { cursor: 12345, limit: 50, types: ['note', 'task'] }
      const result = PullSyncRequestSchema.parse(request)
      expect(result.cursor).toBe(12345)
      expect(result.types).toEqual(['note', 'task'])
    })

    it('PullSyncResponseSchema should validate valid response', () => {
      const response = {
        items: [],
        hasMore: false,
        nextCursor: 12345,
        serverTime: Date.now()
      }
      const result = PullSyncResponseSchema.parse(response)
      expect(result.hasMore).toBe(false)
    })
  })
})
