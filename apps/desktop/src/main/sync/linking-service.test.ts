import sodium from 'libsodium-wrappers-sumo'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockSend,
  mockPostToServer,
  mockGetFromServer,
  mockWithRetry,
  mockPersistKeysAndRegisterDevice,
  mockCollectGoogleProviderAuthTransfer,
  mockEncryptGoogleProviderAuthTransfer,
  mockDecryptGoogleProviderAuthTransfer,
  mockPersistImportedGoogleProviderAuth,
  mockGetDatabase,
  encKey,
  macKey,
  sharedSecret,
  masterKey
} = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockPostToServer: vi.fn(),
  mockGetFromServer: vi.fn(),
  mockWithRetry: vi.fn(async (fn: () => Promise<unknown>) => ({
    value: await fn(),
    attempts: 1
  })),
  mockPersistKeysAndRegisterDevice: vi.fn(),
  mockCollectGoogleProviderAuthTransfer: vi.fn(),
  mockEncryptGoogleProviderAuthTransfer: vi.fn(),
  mockDecryptGoogleProviderAuthTransfer: vi.fn(),
  mockPersistImportedGoogleProviderAuth: vi.fn(),
  mockGetDatabase: vi.fn(),
  encKey: new Uint8Array(32).fill(7),
  macKey: new Uint8Array(32).fill(9),
  sharedSecret: new Uint8Array(32).fill(5),
  masterKey: new Uint8Array(32).fill(3)
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ webContents: { send: mockSend } }]
  }
}))

vi.mock('./http-client', () => ({
  postToServer: mockPostToServer,
  getFromServer: mockGetFromServer,
  SyncServerError: class SyncServerError extends Error {
    constructor(
      message: string,
      public readonly statusCode: number
    ) {
      super(message)
    }
  }
}))

vi.mock('./retry', () => ({
  withRetry: mockWithRetry
}))

vi.mock('./device-registration', () => ({
  persistKeysAndRegisterDevice: mockPersistKeysAndRegisterDevice
}))

vi.mock('../database/client', () => ({
  getDatabase: mockGetDatabase
}))

vi.mock('../calendar/google/provider-auth-transfer', () => ({
  collectGoogleProviderAuthTransfer: mockCollectGoogleProviderAuthTransfer,
  encryptGoogleProviderAuthTransfer: mockEncryptGoogleProviderAuthTransfer,
  decryptGoogleProviderAuthTransfer: mockDecryptGoogleProviderAuthTransfer,
  persistImportedGoogleProviderAuth: mockPersistImportedGoogleProviderAuth
}))

vi.mock('../crypto', () => ({
  CBOR_FIELD_ORDER: {},
  computeKeyConfirm: vi.fn(() => new Uint8Array(32).fill(11)),
  computeLinkingProof: vi.fn(() => new Uint8Array(32).fill(12)),
  computeProviderAuthConfirm: vi.fn(() => new Uint8Array(32).fill(13)),
  computeSharedSecret: vi.fn(async () => sharedSecret),
  computeVerificationCode: vi.fn(async () => '123456'),
  constantTimeEqual: vi.fn(() => true),
  decryptMasterKeyFromLinking: vi.fn(() => masterKey),
  deriveLinkingKeys: vi.fn(async () => ({ encKey, macKey })),
  encodeCbor: vi.fn(() => new Uint8Array([1, 2, 3])),
  encryptMasterKeyForLinking: vi.fn(() => ({
    ciphertext: new Uint8Array([41, 42, 43]),
    nonce: new Uint8Array(24).fill(8)
  })),
  generateX25519KeyPair: vi.fn(async () => ({
    publicKey: new Uint8Array(32).fill(21),
    secretKey: new Uint8Array(32).fill(22)
  })),
  getOrCreateSigningKeyPair: vi.fn(async () => ({
    deviceId: 'device-signing-id',
    publicKey: new Uint8Array(32).fill(31),
    secretKey: new Uint8Array(64).fill(32)
  })),
  retrieveKey: vi.fn(async () => masterKey),
  secureCleanup: vi.fn()
}))

import {
  approveDeviceLinking,
  clearPendingLinkCompletion,
  clearPendingSession,
  completeLinkingQr,
  initiateDeviceLinking,
  linkViaQr
} from './linking-service'

describe('linking-service provider auth transfer', () => {
  const waitUntil = async (assertion: () => void, timeoutMs = 250): Promise<void> => {
    const startedAt = Date.now()
    let lastError: unknown

    while (Date.now() - startedAt < timeoutMs) {
      try {
        assertion()
        return
      } catch (error) {
        lastError = error
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }

    throw lastError instanceof Error ? lastError : new Error('Timed out waiting for assertion')
  }

  beforeAll(async () => {
    await sodium.ready
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetDatabase.mockReturnValue({ tag: 'db' })
    mockPostToServer.mockImplementation(async (path: string) => {
      if (path === '/auth/linking/initiate') {
        return {
          sessionId: 'session-1',
          expiresAt: Math.floor(Date.now() / 1000) + 300,
          linkingSecret: sodium.to_base64(
            new Uint8Array(32).fill(4),
            sodium.base64_variants.ORIGINAL
          )
        }
      }

      if (path === '/auth/linking/scan') {
        return { success: true }
      }

      if (path === '/auth/linking/complete') {
        return {
          success: true,
          encryptedMasterKey: sodium.to_base64(
            new Uint8Array([41, 42, 43]),
            sodium.base64_variants.ORIGINAL
          ),
          encryptedKeyNonce: sodium.to_base64(
            new Uint8Array(24).fill(8),
            sodium.base64_variants.ORIGINAL
          ),
          keyConfirm: sodium.to_base64(new Uint8Array(32).fill(11), sodium.base64_variants.ORIGINAL)
        }
      }

      return { success: true }
    })
    mockGetFromServer.mockImplementation(async (path: string) => {
      if (path === '/auth/linking/session/session-1') {
        return {
          sessionId: 'session-1',
          status: 'scanned',
          newDevicePublicKey: sodium.to_base64(
            new Uint8Array(32).fill(51),
            sodium.base64_variants.ORIGINAL
          ),
          newDeviceConfirm: sodium.to_base64(
            new Uint8Array(32).fill(12),
            sodium.base64_variants.ORIGINAL
          ),
          expiresAt: Math.floor(Date.now() / 1000) + 300
        }
      }

      if (path === '/auth/recovery-info') {
        return {
          kdfSalt: 'salt',
          keyVerifier: 'verifier'
        }
      }

      throw new Error(`Unexpected GET path: ${path}`)
    })
    mockCollectGoogleProviderAuthTransfer.mockResolvedValue({
      version: 1,
      providers: [{ provider: 'google', accountId: 'account-a', refreshToken: 'refresh-a' }]
    })
    mockEncryptGoogleProviderAuthTransfer.mockReturnValue({
      encryptedProviderAuth: 'encrypted-provider-auth',
      encryptedProviderAuthNonce: 'provider-auth-nonce',
      providerAuthConfirm: 'provider-auth-confirm',
      providerAuthVersion: 1
    })
    mockDecryptGoogleProviderAuthTransfer.mockReturnValue({
      version: 1,
      providers: [{ provider: 'google', accountId: 'account-a', refreshToken: 'refresh-a' }]
    })
    mockPersistKeysAndRegisterDevice.mockResolvedValue('device-1')
    mockPersistImportedGoogleProviderAuth.mockResolvedValue({
      importedAccountIds: ['account-a'],
      failedImports: []
    })
  })

  afterEach(() => {
    clearPendingSession()
    clearPendingLinkCompletion()
  })

  it('posts encrypted provider auth alongside the master key when approving a link', async () => {
    await initiateDeviceLinking('access-token')

    const result = await approveDeviceLinking('session-1', 'access-token')

    expect(result).toEqual({ success: true })
    expect(mockCollectGoogleProviderAuthTransfer).toHaveBeenCalledWith({ tag: 'db' })
    expect(mockEncryptGoogleProviderAuthTransfer).toHaveBeenCalledWith({
      transfer: {
        version: 1,
        providers: [{ provider: 'google', accountId: 'account-a', refreshToken: 'refresh-a' }]
      },
      sessionId: 'session-1',
      encKey,
      macKey
    })
    expect(mockPostToServer).toHaveBeenCalledWith(
      '/auth/linking/approve',
      expect.objectContaining({
        sessionId: 'session-1',
        encryptedMasterKey: expect.any(String),
        encryptedKeyNonce: expect.any(String),
        keyConfirm: expect.any(String),
        encryptedProviderAuth: 'encrypted-provider-auth',
        encryptedProviderAuthNonce: 'provider-auth-nonce',
        providerAuthConfirm: 'provider-auth-confirm',
        providerAuthVersion: 1
      }),
      'access-token'
    )
  })

  it('imports transferred provider auth only after device registration succeeds', async () => {
    mockPostToServer.mockImplementation(async (path: string) => {
      if (path === '/auth/linking/scan') {
        return { success: true }
      }

      if (path === '/auth/linking/complete') {
        return {
          success: true,
          encryptedMasterKey: sodium.to_base64(
            new Uint8Array([41, 42, 43]),
            sodium.base64_variants.ORIGINAL
          ),
          encryptedKeyNonce: sodium.to_base64(
            new Uint8Array(24).fill(8),
            sodium.base64_variants.ORIGINAL
          ),
          keyConfirm: sodium.to_base64(
            new Uint8Array(32).fill(11),
            sodium.base64_variants.ORIGINAL
          ),
          encryptedProviderAuth: 'encrypted-provider-auth',
          encryptedProviderAuthNonce: 'provider-auth-nonce',
          providerAuthConfirm: 'provider-auth-confirm',
          providerAuthVersion: 1
        }
      }

      return {
        sessionId: 'session-1',
        expiresAt: Math.floor(Date.now() / 1000) + 300,
        linkingSecret: sodium.to_base64(new Uint8Array(32).fill(4), sodium.base64_variants.ORIGINAL)
      }
    })

    const qrData = JSON.stringify({
      sessionId: 'session-1',
      ephemeralPublicKey: sodium.to_base64(
        new Uint8Array(32).fill(71),
        sodium.base64_variants.ORIGINAL
      ),
      linkingSecret: sodium.to_base64(new Uint8Array(32).fill(4), sodium.base64_variants.ORIGINAL),
      expiresAt: Math.floor(Date.now() / 1000) + 300
    })

    await linkViaQr(qrData, 'setup-token')
    const result = await completeLinkingQr('session-1')

    expect(result).toEqual({ success: true })
    await waitUntil(() => {
      expect(mockPersistKeysAndRegisterDevice).toHaveBeenCalled()
      expect(mockPersistImportedGoogleProviderAuth).toHaveBeenCalledWith({
        version: 1,
        providers: [{ provider: 'google', accountId: 'account-a', refreshToken: 'refresh-a' }]
      })
      expect(mockSend).toHaveBeenCalledWith('sync:linking-finalized', { deviceId: 'device-1' })
    })
    expect(mockPersistKeysAndRegisterDevice.mock.invocationCallOrder[0]).toBeLessThan(
      mockPersistImportedGoogleProviderAuth.mock.invocationCallOrder[0]
    )
  })

  it('emits a non-fatal warning when imported provider auth cannot be persisted', async () => {
    mockPostToServer.mockImplementation(async (path: string) => {
      if (path === '/auth/linking/scan') {
        return { success: true }
      }

      if (path === '/auth/linking/complete') {
        return {
          success: true,
          encryptedMasterKey: sodium.to_base64(
            new Uint8Array([41, 42, 43]),
            sodium.base64_variants.ORIGINAL
          ),
          encryptedKeyNonce: sodium.to_base64(
            new Uint8Array(24).fill(8),
            sodium.base64_variants.ORIGINAL
          ),
          keyConfirm: sodium.to_base64(
            new Uint8Array(32).fill(11),
            sodium.base64_variants.ORIGINAL
          ),
          encryptedProviderAuth: 'encrypted-provider-auth',
          encryptedProviderAuthNonce: 'provider-auth-nonce',
          providerAuthConfirm: 'provider-auth-confirm',
          providerAuthVersion: 1
        }
      }

      return {
        sessionId: 'session-1',
        expiresAt: Math.floor(Date.now() / 1000) + 300,
        linkingSecret: sodium.to_base64(new Uint8Array(32).fill(4), sodium.base64_variants.ORIGINAL)
      }
    })
    mockPersistImportedGoogleProviderAuth.mockResolvedValue({
      importedAccountIds: [],
      failedImports: [{ accountId: 'account-b', error: 'keychain unavailable' }]
    })

    const qrData = JSON.stringify({
      sessionId: 'session-1',
      ephemeralPublicKey: sodium.to_base64(
        new Uint8Array(32).fill(71),
        sodium.base64_variants.ORIGINAL
      ),
      linkingSecret: sodium.to_base64(new Uint8Array(32).fill(4), sodium.base64_variants.ORIGINAL),
      expiresAt: Math.floor(Date.now() / 1000) + 300
    })

    await linkViaQr(qrData, 'setup-token')
    const result = await completeLinkingQr('session-1')

    expect(result).toEqual({ success: true })
    await waitUntil(() => {
      expect(mockSend).toHaveBeenCalledWith('sync:linking-finalized', {
        deviceId: 'device-1',
        warning: 'Google Calendar needs reconnect on this device for: account-b'
      })
    })
  })
})
