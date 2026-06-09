import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { mockIpcMain, resetIpcMocks, invokeHandler } from '@tests/utils/mock-ipc'
import { SYNC_CHANNELS } from '@memry/contracts/ipc-sync'
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
    getVerifiedVaultKeyMock: vi.fn(async () => new Uint8Array(32)),
    retrieveKeyMock: vi.fn(async () => new Uint8Array(64)),
    getDatabaseMock: vi.fn(),
    getOrCreateVaultUuidMock: vi.fn(() => 'vault-1')
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
  getOrInitializeLocalVaultKey: (...args: unknown[]) => hoisted.getVerifiedVaultKeyMock(...args),
  wrapFileKey: vi.fn(() => ({ wrappedKey: new Uint8Array(48), nonce: new Uint8Array(24) })),
  unwrapFileKey: vi.fn(() => new Uint8Array(32)),
  signPayload: vi.fn(() => new Uint8Array(64)),
  verifySignature: hoisted.verifySignatureMock,
  retrieveKey: hoisted.retrieveKeyMock,
  secureCleanup: vi.fn()
}))

vi.mock('../agent/storage/vault-id', () => ({
  getOrCreateVaultUuid: hoisted.getOrCreateVaultUuidMock
}))

vi.mock('../database', () => ({
  getDatabase: () => hoisted.getDatabaseMock()
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
    hoisted.getVerifiedVaultKeyMock.mockResolvedValue(new Uint8Array(32))
    hoisted.retrieveKeyMock.mockResolvedValue(new Uint8Array(64))
    hoisted.getDatabaseMock.mockReturnValue({})
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
    expect(hoisted.getVerifiedVaultKeyMock).toHaveBeenCalled()
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

    hoisted.getVerifiedVaultKeyMock.mockRejectedValueOnce(new Error('missing key'))
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
})
