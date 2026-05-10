import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { mockIpcMain, resetIpcMocks, invokeHandler } from '@tests/utils/mock-ipc'
import { SYNC_CHANNELS, SYNC_EVENTS } from '@memry/contracts/ipc-sync'
import type { DecryptItemInput, VerifySignatureInput } from '@memry/contracts/ipc-sync'

const VALID_PUBLIC_KEY = 'valid-public-key'
const VALID_SIGNATURE = 'valid-signature'
const MALFORMED_BASE64 = '%%%bad-base64%%%'

const hoisted = vi.hoisted(() => {
  const state = {
    readyPromise: Promise.resolve<void>(undefined),
    readyResolved: true
  }

  return {
    state,
    fromBase64Mock: vi.fn((value: string) => {
      if (value === '%%%bad-base64%%%') {
        throw new Error('invalid base64')
      }

      if (value === 'valid-public-key') {
        return new Uint8Array(32)
      }

      if (value === 'short-key') {
        return new Uint8Array(12)
      }

      if (value === 'valid-signature') {
        return new Uint8Array(64)
      }

      if (value === 'short-signature') {
        return new Uint8Array(12)
      }

      if (value === 'key-nonce' || value === 'data-nonce') {
        return new Uint8Array(24)
      }

      if (value === 'bad-nonce') {
        return new Uint8Array(12)
      }

      if (value === 'encrypted-key') {
        return new Uint8Array(48)
      }

      if (value === 'empty-key') {
        return new Uint8Array(0)
      }

      if (value === 'encrypted-data') {
        return new Uint8Array([1, 2, 3])
      }

      return new Uint8Array(64)
    }),
    verifySignatureMock: vi.fn(() => true),
    decryptMock: vi.fn(() => new TextEncoder().encode(JSON.stringify({ title: 'Decrypted' }))),
    getOrDeriveVaultKeyMock: vi.fn(async () => new Uint8Array(32)),
    retrieveKeyMock: vi.fn(async () => new Uint8Array(64)),
    generateRecoveryPhraseMock: vi.fn(async () => ({
      phrase: 'new recovery phrase',
      seed: new Uint8Array(64)
    })),
    generateSaltMock: vi.fn(() => new Uint8Array(16)),
    deriveMasterKeyMock: vi.fn(async () => ({
      masterKey: new Uint8Array(32),
      kdfSalt: 'new-salt',
      keyVerifier: 'new-verifier'
    })),
    deriveKeyMock: vi.fn(async () => new Uint8Array(32)),
    storeKeyMock: vi.fn(async () => undefined),
    performKeyRotationMock: vi.fn(async () => ({ success: true })),
    getDatabaseMock: vi.fn(),
    getSyncEngineMock: vi.fn(() => null),
    getFromServerMock: vi.fn(),
    postToServerMock: vi.fn(),
    getValidAccessTokenMock: vi.fn(async () => 'access-token'),
    getAllWindowsMock: vi.fn(() => [])
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: unknown) => {
      mockIpcMain.handle(channel, handler as Parameters<typeof mockIpcMain.handle>[1])
    }),
    removeHandler: vi.fn((channel: string) => {
      mockIpcMain.removeHandler(channel)
    })
  },
  BrowserWindow: {
    getAllWindows: () => hoisted.getAllWindowsMock()
  }
}))

vi.mock('libsodium-wrappers-sumo', () => ({
  default: {
    base64_variants: { ORIGINAL: 'ORIGINAL' },
    get ready() {
      return hoisted.state.readyPromise
    },
    from_base64: hoisted.fromBase64Mock,
    to_base64: vi.fn(() => 'encoded'),
    memzero: vi.fn(),
    memcmp: vi.fn(() => true),
    randombytes_buf: vi.fn((length: number) => new Uint8Array(length)),
    crypto_aead_xchacha20poly1305_ietf_encrypt: vi.fn(() => new Uint8Array(1)),
    crypto_aead_xchacha20poly1305_ietf_decrypt: vi.fn(() => new Uint8Array(1)),
    crypto_sign_detached: vi.fn(() => new Uint8Array(64)),
    crypto_sign_verify_detached: vi.fn(() => true),
    crypto_sign_ed25519_sk_to_pk: vi.fn(() => new Uint8Array(32))
  }
}))

vi.mock('../crypto', () => ({
  encrypt: vi.fn(() => ({ ciphertext: new Uint8Array(1), nonce: new Uint8Array(24) })),
  decrypt: (...args: unknown[]) => hoisted.decryptMock(...args),
  generateFileKey: vi.fn(() => new Uint8Array(32)),
  getOrDeriveVaultKey: (...args: unknown[]) => hoisted.getOrDeriveVaultKeyMock(...args),
  wrapFileKey: vi.fn(() => ({ wrappedKey: new Uint8Array(48), nonce: new Uint8Array(24) })),
  unwrapFileKey: vi.fn(() => new Uint8Array(32)),
  signPayload: vi.fn(() => new Uint8Array(64)),
  verifySignature: hoisted.verifySignatureMock,
  retrieveKey: hoisted.retrieveKeyMock,
  generateRecoveryPhrase: hoisted.generateRecoveryPhraseMock,
  generateSalt: hoisted.generateSaltMock,
  deriveMasterKey: hoisted.deriveMasterKeyMock,
  deriveKey: hoisted.deriveKeyMock,
  storeKey: hoisted.storeKeyMock,
  secureCleanup: vi.fn()
}))

vi.mock('../crypto/rotation', () => ({
  performKeyRotation: (...args: unknown[]) => hoisted.performKeyRotationMock(...args)
}))

vi.mock('../database', () => ({
  getDatabase: () => hoisted.getDatabaseMock()
}))

vi.mock('../sync/runtime', () => ({
  getSyncEngine: () => hoisted.getSyncEngineMock()
}))

vi.mock('../sync/http-client', () => ({
  getFromServer: (...args: unknown[]) => hoisted.getFromServerMock(...args),
  postToServer: (...args: unknown[]) => hoisted.postToServerMock(...args)
}))

vi.mock('../sync/token-manager', () => ({
  getValidAccessToken: (...args: unknown[]) => hoisted.getValidAccessTokenMock(...args)
}))

import { registerCryptoHandlers, unregisterCryptoHandlers } from './crypto-handlers'

const baseInput = {
  itemId: 'item-1',
  type: 'task' as const,
  encryptedKey: 'encrypted-key',
  keyNonce: 'key-nonce',
  encryptedData: 'encrypted-data',
  dataNonce: 'data-nonce',
  signature: VALID_SIGNATURE,
  metadata: { signerPublicKey: VALID_PUBLIC_KEY }
}

function createVerifyInput(overrides: Partial<VerifySignatureInput> = {}): VerifySignatureInput {
  return { ...baseInput, ...overrides }
}

function createDecryptInput(overrides: Partial<DecryptItemInput> = {}): DecryptItemInput {
  return { ...baseInput, ...overrides }
}

describe('crypto-handlers', () => {
  beforeEach(() => {
    resetIpcMocks()
    vi.clearAllMocks()
    hoisted.state.readyResolved = true
    hoisted.state.readyPromise = Promise.resolve()
    hoisted.verifySignatureMock.mockImplementation(() => true)
    hoisted.decryptMock.mockReturnValue(
      new TextEncoder().encode(JSON.stringify({ title: 'Decrypted' }))
    )
    hoisted.getOrDeriveVaultKeyMock.mockResolvedValue(new Uint8Array(32))
    hoisted.retrieveKeyMock.mockResolvedValue(new Uint8Array(64))
    hoisted.generateRecoveryPhraseMock.mockResolvedValue({
      phrase: 'new recovery phrase',
      seed: new Uint8Array(64)
    })
    hoisted.generateSaltMock.mockReturnValue(new Uint8Array(16))
    hoisted.deriveMasterKeyMock.mockResolvedValue({
      masterKey: new Uint8Array(32),
      kdfSalt: 'new-salt',
      keyVerifier: 'new-verifier'
    })
    hoisted.deriveKeyMock.mockResolvedValue(new Uint8Array(32))
    hoisted.storeKeyMock.mockResolvedValue(undefined)
    hoisted.performKeyRotationMock.mockResolvedValue({ success: true })
    hoisted.getSyncEngineMock.mockReturnValue(null)
    hoisted.getAllWindowsMock.mockReturnValue([])
    hoisted.getValidAccessTokenMock.mockResolvedValue('access-token')
    hoisted.getDatabaseMock.mockReturnValue({
      select: () => ({
        from: () => ({
          where: () => ({
            get: () => ({ id: 'device-1' })
          })
        })
      })
    })
  })

  afterEach(() => {
    unregisterCryptoHandlers()
  })

  it('returns structured failure for malformed signer public key in decrypt', async () => {
    registerCryptoHandlers()

    const result = await invokeHandler<{ success: boolean; error?: string }>(
      SYNC_CHANNELS.DECRYPT_ITEM,
      createDecryptInput({ metadata: { signerPublicKey: MALFORMED_BASE64 } })
    )

    expect(result).toEqual({ success: false, error: 'Invalid public key length' })
  })

  it('returns structured failure for malformed signature in verify', async () => {
    registerCryptoHandlers()

    const result = await invokeHandler(
      SYNC_CHANNELS.VERIFY_SIGNATURE,
      createVerifyInput({ signature: MALFORMED_BASE64 })
    )

    expect(result).toEqual({ valid: false })
  })

  it('encrypts items with a wrapped file key and detached signature', async () => {
    registerCryptoHandlers()

    const result = await invokeHandler(SYNC_CHANNELS.ENCRYPT_ITEM, {
      itemId: 'task-1',
      type: 'task',
      content: { title: 'Ship coverage' },
      operation: 'create',
      metadata: { projectId: 'project-1' }
    })

    expect(result).toEqual({
      encryptedData: 'encoded',
      dataNonce: 'encoded',
      encryptedKey: 'encoded',
      keyNonce: 'encoded',
      signature: 'encoded'
    })
    expect(hoisted.getOrDeriveVaultKeyMock).toHaveBeenCalled()
    expect(hoisted.retrieveKeyMock).toHaveBeenCalled()
  })

  it('decrypts verified payloads and returns parsed JSON content', async () => {
    registerCryptoHandlers()

    const result = await invokeHandler(SYNC_CHANNELS.DECRYPT_ITEM, createDecryptInput())

    expect(result).toEqual({ success: true, content: { title: 'Decrypted' } })
    expect(hoisted.verifySignatureMock).toHaveBeenCalled()
    expect(hoisted.decryptMock).toHaveBeenCalled()
  })

  it('returns structured decrypt failures for missing signer, bad signatures, and bad payloads', async () => {
    registerCryptoHandlers()

    await expect(
      invokeHandler(SYNC_CHANNELS.DECRYPT_ITEM, createDecryptInput({ metadata: {} }))
    ).resolves.toEqual({
      success: false,
      error: 'Signer public key required for verification'
    })

    await expect(
      invokeHandler(
        SYNC_CHANNELS.DECRYPT_ITEM,
        createDecryptInput({ signature: 'short-signature' })
      )
    ).resolves.toEqual({ success: false, error: 'Invalid signature length' })

    hoisted.verifySignatureMock.mockReturnValueOnce(false)
    await expect(invokeHandler(SYNC_CHANNELS.DECRYPT_ITEM, createDecryptInput())).resolves.toEqual({
      success: false,
      error: 'Signature verification failed'
    })

    hoisted.getOrDeriveVaultKeyMock.mockRejectedValueOnce(new Error('missing key'))
    await expect(invokeHandler(SYNC_CHANNELS.DECRYPT_ITEM, createDecryptInput())).resolves.toEqual({
      success: false,
      error: 'Failed to derive vault key — master key missing'
    })

    await expect(
      invokeHandler(SYNC_CHANNELS.DECRYPT_ITEM, createDecryptInput({ encryptedKey: 'empty-key' }))
    ).resolves.toEqual({ success: false, error: 'Invalid encrypted key length' })

    await expect(
      invokeHandler(SYNC_CHANNELS.DECRYPT_ITEM, createDecryptInput({ keyNonce: 'bad-nonce' }))
    ).resolves.toEqual({ success: false, error: 'Invalid key nonce length' })

    await expect(
      invokeHandler(SYNC_CHANNELS.DECRYPT_ITEM, createDecryptInput({ dataNonce: 'bad-nonce' }))
    ).resolves.toEqual({ success: false, error: 'Invalid data nonce length' })
  })

  it('returns verify failures for missing signer, short keys, short signatures, and failed verify', async () => {
    registerCryptoHandlers()

    await expect(
      invokeHandler(SYNC_CHANNELS.VERIFY_SIGNATURE, createVerifyInput({ metadata: {} }))
    ).resolves.toEqual({ valid: false })
    await expect(
      invokeHandler(
        SYNC_CHANNELS.VERIFY_SIGNATURE,
        createVerifyInput({ metadata: { signerPublicKey: 'short-key' } })
      )
    ).resolves.toEqual({ valid: false })
    await expect(
      invokeHandler(
        SYNC_CHANNELS.VERIFY_SIGNATURE,
        createVerifyInput({ signature: 'short-signature' })
      )
    ).resolves.toEqual({ valid: false })

    hoisted.verifySignatureMock.mockReturnValueOnce(false)
    await expect(
      invokeHandler(SYNC_CHANNELS.VERIFY_SIGNATURE, createVerifyInput())
    ).resolves.toEqual({
      valid: false
    })
  })

  it('throws during encryption when the device signing key is missing', async () => {
    registerCryptoHandlers()
    hoisted.retrieveKeyMock.mockResolvedValueOnce(null)

    await expect(
      invokeHandler(SYNC_CHANNELS.ENCRYPT_ITEM, {
        itemId: 'task-1',
        type: 'task',
        content: { title: 'No key' }
      })
    ).rejects.toThrow('Device signing key not found in keychain')
  })

  it('returns key rotation guard responses and empty progress before rotation starts', async () => {
    registerCryptoHandlers()

    await expect(invokeHandler(SYNC_CHANNELS.ROTATE_KEYS, { confirm: false })).resolves.toEqual({
      success: false,
      error: 'Key rotation not confirmed'
    })
    await expect(invokeHandler(SYNC_CHANNELS.GET_ROTATION_PROGRESS)).resolves.toEqual({
      inProgress: false
    })
  })

  it('waits for sodium.ready before signature verification', async () => {
    registerCryptoHandlers()

    let resolveReady: (() => void) | undefined
    hoisted.state.readyResolved = false
    hoisted.state.readyPromise = new Promise<void>((resolve) => {
      resolveReady = () => {
        hoisted.state.readyResolved = true
        resolve()
      }
    })
    hoisted.verifySignatureMock.mockImplementation(() => hoisted.state.readyResolved)

    const pending = invokeHandler<{ valid: boolean }>(
      SYNC_CHANNELS.VERIFY_SIGNATURE,
      createVerifyInput()
    )

    let settled = false
    void pending.finally(() => {
      settled = true
    })

    await Promise.resolve()
    expect(settled).toBe(false)

    resolveReady?.()
    const result = await pending

    expect(result).toEqual({ valid: true })
  })

  it('rotates keys, emits progress, pauses sync, and exposes current rotation progress', async () => {
    const send = vi.fn()
    const pause = vi.fn()
    const resume = vi.fn()
    hoisted.getAllWindowsMock.mockReturnValue([{ webContents: { send } }])
    hoisted.getSyncEngineMock.mockReturnValue({ pause, resume })
    hoisted.performKeyRotationMock.mockImplementationOnce(async (ops: any) => {
      ops.pauseSync()
      const signingKeys = await ops.getSigningKeys()
      ops.onProgress({
        inProgress: true,
        phase: 'reencrypt',
        totalItems: 3,
        processedItems: 2
      })
      ops.resumeSync()
      expect(signingKeys).toEqual({
        secretKey: expect.any(Uint8Array),
        publicKey: expect.any(Uint8Array),
        deviceId: 'device-1'
      })
      return { success: true }
    })
    registerCryptoHandlers()

    await expect(invokeHandler(SYNC_CHANNELS.ROTATE_KEYS, { confirm: true })).resolves.toEqual({
      success: true,
      newRecoveryPhrase: 'new recovery phrase'
    })
    expect(pause).toHaveBeenCalledOnce()
    expect(resume).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith(SYNC_EVENTS.KEY_ROTATION_PROGRESS, {
      phase: 'reencrypt',
      totalItems: 3,
      processedItems: 2,
      error: undefined
    })
    await expect(invokeHandler(SYNC_CHANNELS.GET_ROTATION_PROGRESS)).resolves.toEqual({
      inProgress: true,
      phase: 'reencrypt',
      totalItems: 3,
      processedItems: 2
    })
  })

  it('guards concurrent rotation and returns rotation failures', async () => {
    registerCryptoHandlers()

    let finishRotation!: (value: { success: false; error: string }) => void
    hoisted.performKeyRotationMock.mockReturnValueOnce(
      new Promise((resolve) => {
        finishRotation = resolve
      })
    )

    const first = invokeHandler(SYNC_CHANNELS.ROTATE_KEYS, { confirm: true })
    await Promise.resolve()

    await expect(invokeHandler(SYNC_CHANNELS.ROTATE_KEYS, { confirm: true })).resolves.toEqual({
      success: false,
      error: 'Key rotation already in progress'
    })

    finishRotation({ success: false, error: 'server refused keys' })
    await expect(first).resolves.toEqual({ success: false, error: 'server refused keys' })
  })

  it('returns null signing keys when keychain or database state is missing during rotation', async () => {
    registerCryptoHandlers()

    hoisted.retrieveKeyMock.mockResolvedValueOnce(null)
    hoisted.performKeyRotationMock.mockImplementationOnce(async (ops: any) => {
      expect(await ops.getSigningKeys()).toBeNull()
      return { success: true }
    })
    await invokeHandler(SYNC_CHANNELS.ROTATE_KEYS, { confirm: true })

    hoisted.retrieveKeyMock.mockResolvedValueOnce(new Uint8Array(64))
    hoisted.getDatabaseMock.mockReturnValueOnce({
      select: () => ({
        from: () => ({
          where: () => ({
            get: () => null
          })
        })
      })
    })
    hoisted.performKeyRotationMock.mockImplementationOnce(async (ops: any) => {
      expect(await ops.getSigningKeys()).toBeNull()
      return { success: true }
    })
    await invokeHandler(SYNC_CHANNELS.ROTATE_KEYS, { confirm: true })
  })
})
