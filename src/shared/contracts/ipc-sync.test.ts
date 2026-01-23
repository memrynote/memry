import { describe, it, expect } from 'vitest'
import {
  SyncChannels,
  CryptoChannels,
  AuthChannels,
  isSyncChannel,
  isCryptoChannel,
  isAuthChannel,
  TriggerSyncRequestSchema,
  SetupFirstDeviceRequestSchema,
  VerifyRecoveryPhraseRequestSchema,
  RegisterExistingDeviceRequestSchema,
  ScanLinkingQRRequestSchema,
  RenameDeviceRequestSchema,
  RevokeDeviceRequestSchema,
  ResolveConflictRequestSchema,
  DeriveKeysRequestSchema,
  EncryptItemRequestSchema,
  StartOAuthRequestSchema,
  RequestOtpRequestSchema,
  VerifyOtpRequestSchema,
  ResendOtpRequestSchema
} from '@shared/contracts/ipc-sync'

describe('IPC Sync Contracts', () => {
  describe('Channel Constants', () => {
    it('should have all sync channels', () => {
      expect(SyncChannels.invoke).toHaveProperty('GET_SYNC_STATUS')
      expect(SyncChannels.invoke).toHaveProperty('TRIGGER_SYNC')
      expect(SyncChannels.invoke).toHaveProperty('SETUP_FIRST_DEVICE')
      expect(SyncChannels.invoke).toHaveProperty('CREATE_LINKING_SESSION')
      expect(SyncChannels.invoke).toHaveProperty('GET_DEVICES')
      expect(SyncChannels.invoke).toHaveProperty('GET_USER')
      expect(SyncChannels.invoke).toHaveProperty('GET_CONFLICTS')
    })

    it('should have all sync event channels', () => {
      expect(SyncChannels.events).toHaveProperty('STATUS_CHANGED')
      expect(SyncChannels.events).toHaveProperty('ITEM_SYNCED')
      expect(SyncChannels.events).toHaveProperty('LINKING_COMPLETED')
      expect(SyncChannels.events).toHaveProperty('DEVICE_LINKED')
    })

    it('should have all crypto channels', () => {
      expect(CryptoChannels.invoke).toHaveProperty('DERIVE_KEYS')
      expect(CryptoChannels.invoke).toHaveProperty('ENCRYPT_ITEM')
      expect(CryptoChannels.invoke).toHaveProperty('SIGN_ITEM')
      expect(CryptoChannels.invoke).toHaveProperty('STORE_KEYS')
      expect(CryptoChannels.invoke).toHaveProperty('GENERATE_LINKING_KEYPAIR')
    })

    it('should have all auth channels', () => {
      expect(AuthChannels.invoke).toHaveProperty('REQUEST_OTP')
      expect(AuthChannels.invoke).toHaveProperty('VERIFY_OTP')
      expect(AuthChannels.invoke).toHaveProperty('START_OAUTH')
      expect(AuthChannels.invoke).toHaveProperty('GET_SESSION')
      expect(AuthChannels.invoke).toHaveProperty('LOGOUT')
    })
  })

  describe('Type Guards', () => {
    it('isSyncChannel should return true for sync channels', () => {
      expect(isSyncChannel('sync:get-status')).toBe(true)
      expect(isSyncChannel('sync:trigger')).toBe(true)
      expect(isSyncChannel('sync:status-changed')).toBe(true)
      expect(isSyncChannel('sync:item-synced')).toBe(true)
    })

    it('isSyncChannel should return false for non-sync channels', () => {
      expect(isSyncChannel('crypto:derive-keys')).toBe(false)
      expect(isSyncChannel('auth:request-otp')).toBe(false)
      expect(isSyncChannel('unknown:channel')).toBe(false)
    })

    it('isCryptoChannel should return true for crypto channels', () => {
      expect(isCryptoChannel('crypto:derive-keys')).toBe(true)
      expect(isCryptoChannel('crypto:encrypt-item')).toBe(true)
      expect(isCryptoChannel('crypto:keys-derived')).toBe(true)
      expect(isCryptoChannel('crypto:keys-stored')).toBe(true)
    })

    it('isCryptoChannel should return false for non-crypto channels', () => {
      expect(isCryptoChannel('sync:get-status')).toBe(false)
      expect(isCryptoChannel('auth:request-otp')).toBe(false)
      expect(isCryptoChannel('unknown:channel')).toBe(false)
    })

    it('isAuthChannel should return true for auth channels', () => {
      expect(isAuthChannel('auth:request-otp')).toBe(true)
      expect(isAuthChannel('auth:verify-otp')).toBe(true)
      expect(isAuthChannel('auth:start-oauth')).toBe(true)
      expect(isAuthChannel('auth:session-changed')).toBe(true)
    })

    it('isAuthChannel should return false for non-auth channels', () => {
      expect(isAuthChannel('sync:get-status')).toBe(false)
      expect(isAuthChannel('crypto:derive-keys')).toBe(false)
      expect(isAuthChannel('unknown:channel')).toBe(false)
    })
  })

  describe('IPC Request Schemas', () => {
    it('TriggerSyncRequestSchema should validate valid request', () => {
      const valid = { force: true, types: ['note', 'task'] }
      const result = TriggerSyncRequestSchema.parse(valid)
      expect(result.force).toBe(true)
      expect(result.types).toEqual(['note', 'task'])
    })

    it('TriggerSyncRequestSchema should validate minimal request', () => {
      const minimal = {}
      const result = TriggerSyncRequestSchema.parse(minimal)
      expect(result.force).toBeUndefined()
      expect(result.types).toBeUndefined()
    })

    it('SetupFirstDeviceRequestSchema should validate valid request', () => {
      const valid = {
        deviceName: 'My Device',
        platform: 'macos' as const,
        osVersion: '14.0',
        appVersion: '1.0.0'
      }
      const result = SetupFirstDeviceRequestSchema.parse(valid)
      expect(result.deviceName).toBe('My Device')
      expect(result.platform).toBe('macos')
    })

    it('SetupFirstDeviceRequestSchema should reject invalid platform', () => {
      const invalid = {
        deviceName: 'My Device',
        platform: 'invalid' as any,
        osVersion: '14.0',
        appVersion: '1.0.0'
      }
      expect(() => SetupFirstDeviceRequestSchema.parse(invalid)).toThrow()
    })

    it('VerifyRecoveryPhraseRequestSchema should validate 24-word phrase', () => {
      const valid = {
        phrase: Array(24).fill('word')
      }
      const result = VerifyRecoveryPhraseRequestSchema.parse(valid)
      expect(result.phrase).toHaveLength(24)
    })

    it('VerifyRecoveryPhraseRequestSchema should reject wrong length', () => {
      const invalid = { phrase: ['word', 'word'] }
      expect(() => VerifyRecoveryPhraseRequestSchema.parse(invalid)).toThrow()
    })

    it('RegisterExistingDeviceRequestSchema should validate valid request', () => {
      const valid = {
        recoveryPhrase: Array(24).fill('word'),
        deviceName: 'My Device',
        platform: 'windows' as const,
        osVersion: '11.0',
        appVersion: '1.0.0'
      }
      const result = RegisterExistingDeviceRequestSchema.parse(valid)
      expect(result.deviceName).toBe('My Device')
      expect(result.platform).toBe('windows')
    })

    it('ScanLinkingQRRequestSchema should validate valid request', () => {
      const valid = {
        qrContent: 'qr-data',
        deviceName: 'New Device',
        platform: 'linux' as const,
        osVersion: '20.04',
        appVersion: '1.0.0'
      }
      const result = ScanLinkingQRRequestSchema.parse(valid)
      expect(result.qrContent).toBe('qr-data')
    })

    it('RenameDeviceRequestSchema should validate valid request', () => {
      const valid = {
        deviceId: '123e4567-e89b-12d3-a456-426614174000',
        newName: 'Renamed Device'
      }
      const result = RenameDeviceRequestSchema.parse(valid)
      expect(result.newName).toBe('Renamed Device')
    })

    it('RenameDeviceRequestSchema should reject invalid UUID', () => {
      const invalid = {
        deviceId: 'not-a-uuid',
        newName: 'Renamed Device'
      }
      expect(() => RenameDeviceRequestSchema.parse(invalid)).toThrow()
    })

    it('RevokeDeviceRequestSchema should validate valid request', () => {
      const valid = { deviceId: '123e4567-e89b-12d3-a456-426614174000' }
      const result = RevokeDeviceRequestSchema.parse(valid)
      expect(result.deviceId).toBe('123e4567-e89b-12d3-a456-426614174000')
    })

    it('ResolveConflictRequestSchema should validate valid request', () => {
      const valid = {
        itemId: '123e4567-e89b-12d3-a456-426614174000',
        resolution: 'local' as const
      }
      const result = ResolveConflictRequestSchema.parse(valid)
      expect(result.resolution).toBe('local')
    })

    it('ResolveConflictRequestSchema should reject invalid resolution', () => {
      const invalid = {
        itemId: '123e4567-e89b-12d3-a456-426614174000',
        resolution: 'invalid' as any
      }
      expect(() => ResolveConflictRequestSchema.parse(invalid)).toThrow()
    })

    it('DeriveKeysRequestSchema should validate valid request', () => {
      const valid = {
        phrase: Array(24).fill('word'),
        kdfSalt: 'SGVsbG8gV29ybGQ='
      }
      const result = DeriveKeysRequestSchema.parse(valid)
      expect(result.phrase).toHaveLength(24)
    })

    it('EncryptItemRequestSchema should validate valid request', () => {
      const valid = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        type: 'note',
        data: '{"content": "test"}',
        operation: 'create' as const
      }
      const result = EncryptItemRequestSchema.parse(valid)
      expect(result.type).toBe('note')
    })

    it('StartOAuthRequestSchema should validate valid request', () => {
      const valid = { provider: 'google' as const }
      const result = StartOAuthRequestSchema.parse(valid)
      expect(result.provider).toBe('google')
    })

    it('RequestOtpRequestSchema should validate valid request', () => {
      const valid = { email: 'test@example.com' }
      const result = RequestOtpRequestSchema.parse(valid)
      expect(result.email).toBe('test@example.com')
    })

    it('RequestOtpRequestSchema should reject invalid email', () => {
      const invalid = { email: 'not-an-email' }
      expect(() => RequestOtpRequestSchema.parse(invalid)).toThrow()
    })

    it('VerifyOtpRequestSchema should validate valid request', () => {
      const valid = { email: 'test@example.com', code: '123456' }
      const result = VerifyOtpRequestSchema.parse(valid)
      expect(result.code).toBe('123456')
    })

    it('VerifyOtpRequestSchema should reject invalid code format', () => {
      const invalid = { email: 'test@example.com', code: '12345' } // too short
      expect(() => VerifyOtpRequestSchema.parse(invalid)).toThrow()
    })

    it('VerifyOtpRequestSchema should reject non-numeric code', () => {
      const invalid = { email: 'test@example.com', code: 'abcdef' }
      expect(() => VerifyOtpRequestSchema.parse(invalid)).toThrow()
    })

    it('ResendOtpRequestSchema should validate valid request', () => {
      const valid = { email: 'test@example.com' }
      const result = ResendOtpRequestSchema.parse(valid)
      expect(result.email).toBe('test@example.com')
    })
  })
})
