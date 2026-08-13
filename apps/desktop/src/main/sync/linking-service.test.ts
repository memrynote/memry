import fs from 'fs'
import os from 'os'
import path from 'path'

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
  mockCollectVaultTransfer,
  mockEncryptVaultTransfer,
  mockDecryptVaultTransfer,
  mockAdoptVaultLocally,
  mockCreateDormantVault,
  mockSelectVault,
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
  mockCollectVaultTransfer: vi.fn(),
  mockEncryptVaultTransfer: vi.fn(),
  mockDecryptVaultTransfer: vi.fn(),
  mockAdoptVaultLocally: vi.fn(),
  mockCreateDormantVault: vi.fn(),
  mockSelectVault: vi.fn(),
  encKey: new Uint8Array(32).fill(7),
  macKey: new Uint8Array(32).fill(9),
  sharedSecret: new Uint8Array(32).fill(5),
  masterKey: new Uint8Array(32).fill(3)
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mockSend } }]
  }
}))

vi.mock('./http-client', () => {
  class SyncServerError extends Error {
    constructor(
      message: string,
      public readonly statusCode: number
    ) {
      super(message)
    }
  }
  class RateLimitError extends SyncServerError {
    constructor(public readonly retryAfter?: number) {
      super('Too many requests. Please try again later.', 429)
    }
  }
  return {
    postToServer: mockPostToServer,
    getFromServer: mockGetFromServer,
    SyncServerError,
    RateLimitError
  }
})

vi.mock('./retry', () => ({
  withRetry: mockWithRetry
}))

vi.mock('./device-registration', () => ({
  persistKeysAndRegisterDevice: mockPersistKeysAndRegisterDevice
}))

vi.mock('../database/client', () => ({
  getDatabase: mockGetDatabase
}))

vi.mock('../calendar/providers/google/provider-auth-transfer', () => ({
  collectGoogleProviderAuthTransfer: mockCollectGoogleProviderAuthTransfer,
  encryptGoogleProviderAuthTransfer: mockEncryptGoogleProviderAuthTransfer,
  decryptGoogleProviderAuthTransfer: mockDecryptGoogleProviderAuthTransfer,
  persistImportedGoogleProviderAuth: mockPersistImportedGoogleProviderAuth
}))

vi.mock('./vault-transfer', () => ({
  collectVaultTransfer: mockCollectVaultTransfer,
  encryptVaultTransfer: mockEncryptVaultTransfer,
  decryptVaultTransfer: mockDecryptVaultTransfer
}))

vi.mock('./vault-adoption', () => ({
  adoptVaultLocally: mockAdoptVaultLocally
}))

vi.mock('./vault-provisioning', () => ({
  createDormantVault: mockCreateDormantVault,
  dormantVaultFolderName: (uuid: string) => `memry-vault-${uuid.slice(0, 8)}`
}))

vi.mock('../vault', () => ({
  selectVault: mockSelectVault
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
  clearPendingVaultChoice,
  completeLinkingQr,
  finalizeVaultChoice,
  getLinkingVerificationCode,
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
    mockCollectVaultTransfer.mockReturnValue({
      version: 1,
      vaults: [{ vaultUuid: 'vault-uuid-a' }]
    })
    mockEncryptVaultTransfer.mockReturnValue({
      encryptedVaultTransfer: 'encrypted-vault-transfer',
      encryptedVaultTransferNonce: 'vault-transfer-nonce',
      vaultTransferConfirm: 'vault-transfer-confirm',
      vaultTransferVersion: 1
    })
    mockDecryptVaultTransfer.mockReturnValue({
      version: 1,
      vaults: [{ vaultUuid: 'vault-uuid-a' }]
    })
    mockSelectVault.mockResolvedValue({ success: true })
  })

  afterEach(() => {
    clearPendingSession()
    clearPendingLinkCompletion()
    clearPendingVaultChoice()
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

    const approveCall = mockPostToServer.mock.calls.find(
      ([path]) => path === '/auth/linking/approve'
    )
    expect(approveCall).toBeDefined()
    const approveBody = approveCall?.[1] as Record<string, unknown>
    expect(approveBody.encryptedVaultTransfer).toBe('encrypted-vault-transfer')
    expect(approveBody.encryptedVaultTransferNonce).toBe('vault-transfer-nonce')
    expect(approveBody.vaultTransferConfirm).toBe('vault-transfer-confirm')
    expect(approveBody.vaultTransferVersion).toBe(1)
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
          providerAuthVersion: 1,
          encryptedVaultTransfer: 'encrypted-vault-transfer',
          encryptedVaultTransferNonce: 'vault-transfer-nonce',
          vaultTransferConfirm: 'vault-transfer-confirm',
          vaultTransferVersion: 1
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

    expect(mockAdoptVaultLocally).toHaveBeenCalledWith({ tag: 'db' }, 'vault-uuid-a')
    expect(mockAdoptVaultLocally.mock.invocationCallOrder[0]).toBeLessThan(
      mockPersistKeysAndRegisterDevice.mock.invocationCallOrder[0]
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

  it('returns guard errors for invalid QR data and missing sessions', async () => {
    expect(await linkViaQr('not-json', 'setup-token')).toEqual({
      success: false,
      error: 'Invalid QR code data'
    })

    expect(await linkViaQr(JSON.stringify({ sessionId: 'session-1' }), 'setup-token')).toEqual({
      success: false,
      error: 'Malformed QR code data'
    })

    expect(
      await linkViaQr(
        JSON.stringify({
          sessionId: 'session-1',
          ephemeralPublicKey: sodium.to_base64(
            new Uint8Array(32).fill(71),
            sodium.base64_variants.ORIGINAL
          ),
          linkingSecret: sodium.to_base64(
            new Uint8Array(32).fill(4),
            sodium.base64_variants.ORIGINAL
          ),
          expiresAt: Math.floor(Date.now() / 1000) - 1
        }),
        'setup-token'
      )
    ).toEqual({ success: false, error: 'Linking session has expired' })

    expect(await completeLinkingQr('missing')).toEqual({
      success: false,
      error: 'No pending linking session found'
    })
    expect(await approveDeviceLinking('missing', 'access-token')).toEqual({
      success: false,
      error: 'No pending linking session found for this session ID'
    })
    expect(await getLinkingVerificationCode('missing', 'access-token')).toEqual({
      error: 'No pending linking session found'
    })
  })

  it('expires pending sessions before approval or completion', async () => {
    await initiateDeviceLinking('access-token')
    const expiredNow = Math.floor(Date.now() / 1000) + 301
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(expiredNow * 1000)

    expect(await approveDeviceLinking('session-1', 'access-token')).toEqual({
      success: false,
      error: 'Linking session has expired'
    })

    dateNowSpy.mockRestore()

    const expiresAt = Math.floor(Date.now() / 1000) + 300
    await linkViaQr(
      JSON.stringify({
        sessionId: 'session-1',
        ephemeralPublicKey: sodium.to_base64(
          new Uint8Array(32).fill(71),
          sodium.base64_variants.ORIGINAL
        ),
        linkingSecret: sodium.to_base64(
          new Uint8Array(32).fill(4),
          sodium.base64_variants.ORIGINAL
        ),
        expiresAt
      }),
      'setup-token'
    )

    const completeDateNowSpy = vi.spyOn(Date, 'now').mockReturnValue((expiresAt + 1) * 1000)
    expect(await completeLinkingQr('session-1')).toEqual({
      success: false,
      error: 'Linking session has expired'
    })
    completeDateNowSpy.mockRestore()
  })

  it('reports not-yet-approved completion states without clearing the pending session', async () => {
    const { SyncServerError } = await import('./http-client')
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
    mockPostToServer.mockResolvedValueOnce({ success: true })
    expect(await completeLinkingQr('session-1')).toEqual({
      success: false,
      error: 'Session not yet approved'
    })

    await linkViaQr(qrData, 'setup-token')
    mockPostToServer.mockRejectedValueOnce(new SyncServerError('wait', 409))
    expect(await completeLinkingQr('session-1')).toEqual({
      success: false,
      error: 'Session not yet approved'
    })
  })

  it('treats rate-limit (429) as transient — soft error, pending session survives', async () => {
    const { RateLimitError } = await import('./http-client')
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

    // A 429 must NOT throw or clear the session — it returns a soft error whose
    // message LinkingPending skips on, so the next poll tick simply retries.
    mockPostToServer.mockRejectedValueOnce(new RateLimitError(60))
    const rateLimited = await completeLinkingQr('session-1')
    expect(rateLimited.success).toBe(false)
    expect(rateLimited.error).toContain('Too many requests')

    // Session still pending (not wiped) → the next poll resolves normally.
    mockPostToServer.mockResolvedValueOnce({ success: true })
    expect(await completeLinkingQr('session-1')).toEqual({
      success: false,
      error: 'Session not yet approved'
    })
  })

  it('rejects tampered approvals and missing local master keys', async () => {
    const crypto = await import('../crypto')

    await initiateDeviceLinking('access-token')
    vi.mocked(crypto.constantTimeEqual).mockReturnValueOnce(false)
    expect(await approveDeviceLinking('session-1', 'access-token')).toEqual({
      success: false,
      error: 'Device verification failed — linking data may be corrupted'
    })

    await initiateDeviceLinking('access-token')
    vi.mocked(crypto.retrieveKey).mockResolvedValueOnce(null)
    expect(await approveDeviceLinking('session-1', 'access-token')).toEqual({
      success: false,
      error: 'Master key not found in keychain'
    })
  })

  it('handles unscanned sessions, verification codes, and provider decrypt warnings', async () => {
    const qrData = JSON.stringify({
      sessionId: 'session-1',
      ephemeralPublicKey: sodium.to_base64(
        new Uint8Array(32).fill(71),
        sodium.base64_variants.ORIGINAL
      ),
      linkingSecret: sodium.to_base64(new Uint8Array(32).fill(4), sodium.base64_variants.ORIGINAL),
      expiresAt: Math.floor(Date.now() / 1000) + 300
    })

    await initiateDeviceLinking('access-token')
    mockGetFromServer.mockResolvedValueOnce({
      sessionId: 'session-1',
      status: 'pending',
      newDevicePublicKey: null,
      newDeviceConfirm: null,
      expiresAt: Math.floor(Date.now() / 1000) + 300
    })
    expect(await approveDeviceLinking('session-1', 'access-token')).toEqual({
      success: false,
      error: 'Session has not been scanned yet'
    })

    await initiateDeviceLinking('access-token')
    expect(await getLinkingVerificationCode('session-1', 'access-token')).toEqual({
      verificationCode: '123456'
    })

    await initiateDeviceLinking('access-token')
    mockGetFromServer.mockResolvedValueOnce({
      sessionId: 'session-1',
      status: 'pending',
      newDevicePublicKey: null,
      expiresAt: Math.floor(Date.now() / 1000) + 300
    })
    expect(await getLinkingVerificationCode('session-1', 'access-token')).toEqual({
      error: 'Session has not been scanned yet'
    })

    mockPostToServer.mockImplementation(async (path: string) => {
      if (path === '/auth/linking/scan') return { success: true }
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
      return { success: true }
    })
    mockDecryptGoogleProviderAuthTransfer.mockImplementationOnce(() => {
      throw new Error('bad provider payload')
    })

    await linkViaQr(qrData, 'setup-token')
    expect(await completeLinkingQr('session-1')).toEqual({ success: true })
    await waitUntil(() => {
      expect(mockSend).toHaveBeenCalledWith('sync:linking-finalized', {
        deviceId: 'device-1',
        warning:
          'Google Calendar auth could not be restored on this device. Reconnect Google if needed.'
      })
    })
  })
})

describe('linking-service multi-vault choice', () => {
  const qrData = JSON.stringify({
    sessionId: 'session-1',
    ephemeralPublicKey: sodium.to_base64(
      new Uint8Array(32).fill(71),
      sodium.base64_variants.ORIGINAL
    ),
    linkingSecret: sodium.to_base64(new Uint8Array(32).fill(4), sodium.base64_variants.ORIGINAL),
    expiresAt: Math.floor(Date.now() / 1000) + 300
  })

  beforeAll(async () => {
    await sodium.ready
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetDatabase.mockReturnValue({ tag: 'db' })
    mockPersistKeysAndRegisterDevice.mockResolvedValue('device-1')
    mockSelectVault.mockResolvedValue({ success: true })
    mockPostToServer.mockImplementation(async (path: string) => {
      if (path === '/auth/linking/scan') return { success: true }
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
          encryptedVaultTransfer: 'encrypted-vault-transfer',
          encryptedVaultTransferNonce: 'vault-transfer-nonce',
          vaultTransferConfirm: 'vault-transfer-confirm',
          vaultTransferVersion: 1
        }
      }
      return { success: true }
    })
    mockGetFromServer.mockImplementation(async (path: string) => {
      if (path === '/auth/recovery-info') return { kdfSalt: 'salt', keyVerifier: 'verifier' }
      throw new Error(`Unexpected GET path: ${path}`)
    })
    mockDecryptVaultTransfer.mockReturnValue({
      version: 1,
      vaults: [
        { vaultUuid: 'v-a', itemCount: 367 },
        { vaultUuid: 'v-b', itemCount: 4 }
      ]
    })
  })

  afterEach(() => {
    clearPendingSession()
    clearPendingLinkCompletion()
    clearPendingVaultChoice()
  })

  it('returns the vault list and defers finalize when 2+ vaults', async () => {
    await linkViaQr(qrData, 'setup-token')
    const res = await completeLinkingQr('session-1')

    expect(res.success).toBe(true)
    expect(res.vaults).toEqual([
      { vaultUuid: 'v-a', itemCount: 367, createdAt: undefined },
      { vaultUuid: 'v-b', itemCount: 4, createdAt: undefined }
    ])
    expect(mockPersistKeysAndRegisterDevice).not.toHaveBeenCalled()
  })

  it('finalizeVaultChoice opens only the primary, then registers (non-primaries stay cloud-only)', async () => {
    await linkViaQr(qrData, 'setup-token')
    await completeLinkingQr('session-1')

    const result = await finalizeVaultChoice({
      sessionId: 'session-1',
      parentFolderPath: '/tmp/parent',
      selectedVaultUuids: ['v-a', 'v-b'],
      primaryVaultUuid: 'v-a'
    })

    expect(result).toEqual({ success: true })
    // Non-primary vaults are no longer provisioned eagerly — they appear in the
    // switcher's "In your account" section via the vault directory instead.
    expect(mockCreateDormantVault).toHaveBeenCalledTimes(1)
    expect(mockCreateDormantVault).toHaveBeenCalledWith(expect.stringContaining('v-a'), 'v-a')
    expect(mockSelectVault).toHaveBeenCalledWith({ path: expect.stringContaining('v-a') })
    expect(mockSelectVault.mock.invocationCallOrder[0]).toBeLessThan(
      mockPersistKeysAndRegisterDevice.mock.invocationCallOrder[0]
    )
  })

  it('provisions the primary vault folder on disk before opening it', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-vault-choice-'))
    // Mirror the real selectVault: it validates the directory BEFORE openVault
    // would initialize it, so an unprovisioned folder fails the whole finalize.
    mockSelectVault.mockImplementation(async ({ path: vaultPath }: { path: string }) =>
      fs.existsSync(vaultPath)
        ? { success: true }
        : { success: false, error: 'Selected path is not a valid directory' }
    )
    // Mirror createDormantVault: initVault() creates the folder on disk.
    mockCreateDormantVault.mockImplementation((folder: string) =>
      fs.mkdirSync(folder, { recursive: true })
    )

    try {
      await linkViaQr(qrData, 'setup-token')
      await completeLinkingQr('session-1')

      const result = await finalizeVaultChoice({
        sessionId: 'session-1',
        parentFolderPath: parent,
        selectedVaultUuids: ['v-a', 'v-b'],
        primaryVaultUuid: 'v-a'
      })

      expect(result).toEqual({ success: true })
      expect(fs.existsSync(path.join(parent, 'memry-vault-v-a'))).toBe(true)
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  it('keeps the choice retryable when opening the primary vault fails', async () => {
    await linkViaQr(qrData, 'setup-token')
    await completeLinkingQr('session-1')

    mockSelectVault.mockResolvedValueOnce({
      success: false,
      error: 'Selected path is not a valid directory'
    })

    const input = {
      sessionId: 'session-1',
      parentFolderPath: '/tmp/parent',
      selectedVaultUuids: ['v-a', 'v-b'],
      primaryVaultUuid: 'v-a'
    }

    expect(await finalizeVaultChoice(input)).toEqual({
      success: false,
      error: 'Selected path is not a valid directory'
    })

    // The master key must survive a failed attempt: the user retries from the
    // same picker (e.g. after choosing a writable folder) without re-linking.
    expect(await finalizeVaultChoice(input)).toEqual({ success: true })
    expect(mockPersistKeysAndRegisterDevice).toHaveBeenCalledTimes(1)
  })

  it('rejects a finalize for a session without a pending vault choice', async () => {
    expect(
      await finalizeVaultChoice({
        sessionId: 'missing',
        parentFolderPath: '/tmp/parent',
        selectedVaultUuids: ['v-a'],
        primaryVaultUuid: 'v-a'
      })
    ).toEqual({ success: false, error: 'No pending vault choice for this session' })
  })

  it('rejects when the primary is not among the selected vaults', async () => {
    await linkViaQr(qrData, 'setup-token')
    await completeLinkingQr('session-1')

    expect(
      await finalizeVaultChoice({
        sessionId: 'session-1',
        parentFolderPath: '/tmp/parent',
        selectedVaultUuids: ['v-b'],
        primaryVaultUuid: 'v-a'
      })
    ).toEqual({ success: false, error: 'Primary vault must be among the selected vaults' })
  })
})
