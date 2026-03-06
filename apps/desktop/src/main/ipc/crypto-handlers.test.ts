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

      if (value === 'valid-signature') {
        return new Uint8Array(64)
      }

      return new Uint8Array(64)
    }),
    verifySignatureMock: vi.fn(() => true),
    retrieveKeyMock: vi.fn(async () => new Uint8Array(32))
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
    crypto_sign_verify_detached: vi.fn(() => true)
  }
}))

vi.mock('../crypto', () => ({
  encrypt: vi.fn(() => ({ ciphertext: new Uint8Array(1), nonce: new Uint8Array(24) })),
  decrypt: vi.fn(() => new Uint8Array(1)),
  generateFileKey: vi.fn(() => new Uint8Array(32)),
  wrapFileKey: vi.fn(() => ({ wrappedKey: new Uint8Array(48), nonce: new Uint8Array(24) })),
  unwrapFileKey: vi.fn(() => new Uint8Array(32)),
  signPayload: vi.fn(() => new Uint8Array(64)),
  verifySignature: hoisted.verifySignatureMock,
  retrieveKey: hoisted.retrieveKeyMock,
  secureCleanup: vi.fn()
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
    hoisted.retrieveKeyMock.mockResolvedValue(new Uint8Array(32))
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
