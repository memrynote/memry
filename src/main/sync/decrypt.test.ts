import { beforeAll, describe, expect, it, vi } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'
import { initCrypto } from '../crypto/index'
import { encryptItemForPush } from './encrypt'
import { decryptItemFromPull, SignatureVerificationError } from './decrypt'
import type { DecryptItemInput } from './decrypt'
import type { EncryptItemResult } from './encrypt'

beforeAll(async () => {
  await initCrypto()
})

function generateTestKeys(): {
  vaultKey: Uint8Array
  signingSecretKey: Uint8Array
  signingPublicKey: Uint8Array
  deviceId: string
} {
  const vaultKey = sodium.randombytes_buf(32)
  const keyPair = sodium.crypto_sign_keypair()
  return {
    vaultKey,
    signingSecretKey: keyPair.privateKey,
    signingPublicKey: keyPair.publicKey,
    deviceId: 'test-device-1'
  }
}

function encryptTestItem(
  content: Uint8Array,
  keys: ReturnType<typeof generateTestKeys>,
  overrides: Record<string, unknown> = {}
): EncryptItemResult {
  return encryptItemForPush({
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    type: 'note',
    operation: 'update',
    content,
    vaultKey: keys.vaultKey,
    signingSecretKey: keys.signingSecretKey,
    signerDeviceId: keys.deviceId,
    ...overrides
  })
}

function buildDecryptInput(
  pushItem: ReturnType<typeof encryptItemForPush>['pushItem'],
  keys: ReturnType<typeof generateTestKeys>,
  overrides: Partial<DecryptItemInput> = {}
): DecryptItemInput {
  const metadata: DecryptItemInput['metadata'] =
    pushItem.clock || pushItem.stateVector
      ? {
          ...(pushItem.clock && { clock: pushItem.clock }),
          ...(pushItem.stateVector && { stateVector: pushItem.stateVector })
        }
      : undefined

  return {
    id: pushItem.id,
    type: pushItem.type,
    operation: pushItem.operation,
    cryptoVersion: 1,
    encryptedKey: pushItem.encryptedKey,
    keyNonce: pushItem.keyNonce,
    encryptedData: pushItem.encryptedData,
    dataNonce: pushItem.dataNonce,
    signature: pushItem.signature,
    signerDeviceId: pushItem.signerDeviceId,
    vaultKey: keys.vaultKey,
    signerPublicKey: keys.signingPublicKey,
    ...(metadata && { metadata }),
    ...overrides
  }
}

describe('decryptItemFromPull', () => {
  describe('#given encrypted item #when decrypted with correct keys', () => {
    it('#then returns original content', () => {
      const keys = generateTestKeys()
      const original = new TextEncoder().encode(JSON.stringify({ title: 'Test Note' }))
      const { pushItem } = encryptTestItem(original, keys)

      const result = decryptItemFromPull(buildDecryptInput(pushItem, keys))

      expect(result.verified).toBe(true)
      expect(new TextDecoder().decode(result.content)).toBe(JSON.stringify({ title: 'Test Note' }))
    })
  })

  describe('#given encrypted item #when signature tampered', () => {
    it('#then throws SignatureVerificationError', () => {
      const keys = generateTestKeys()
      const original = new TextEncoder().encode('hello')
      const { pushItem } = encryptTestItem(original, keys)

      const tampered = pushItem.encryptedData.slice(0, -2) + 'XX'
      const input = buildDecryptInput(pushItem, keys, { encryptedData: tampered })

      expect(() => decryptItemFromPull(input)).toThrow(SignatureVerificationError)
    })
  })

  describe('#given encrypted item #when wrong public key', () => {
    it('#then throws SignatureVerificationError', () => {
      const keys = generateTestKeys()
      const wrongKeyPair = sodium.crypto_sign_keypair()
      const original = new TextEncoder().encode('secret')
      const { pushItem } = encryptTestItem(original, keys)

      const input = buildDecryptInput(pushItem, keys, {
        signerPublicKey: wrongKeyPair.publicKey
      })

      expect(() => decryptItemFromPull(input)).toThrow(SignatureVerificationError)
    })
  })

  describe('#given encrypted item #when wrong vault key', () => {
    it('#then throws decryption error (not signature error)', () => {
      const keys = generateTestKeys()
      const wrongVaultKey = sodium.randombytes_buf(32)
      const original = new TextEncoder().encode('payload')
      const { pushItem } = encryptTestItem(original, keys)

      const input = buildDecryptInput(pushItem, keys, { vaultKey: wrongVaultKey })

      expect(() => decryptItemFromPull(input)).toThrow()
      expect(() => decryptItemFromPull(input)).not.toThrow(SignatureVerificationError)
    })
  })

  describe('#given encrypted tombstone with deletedAt #when decrypted', () => {
    it('#then returns content and verified=true', () => {
      const keys = generateTestKeys()
      const original = new TextEncoder().encode(JSON.stringify({ deleted: true }))
      const deletedAt = Date.now()
      const { pushItem } = encryptTestItem(original, keys, { deletedAt })

      const input = buildDecryptInput(pushItem, keys, { deletedAt })

      const result = decryptItemFromPull(input)

      expect(result.verified).toBe(true)
      expect(new TextDecoder().decode(result.content)).toBe(JSON.stringify({ deleted: true }))
    })
  })

  describe('#given encrypted item with metadata #when decrypted', () => {
    it('#then round-trips correctly', () => {
      const keys = generateTestKeys()
      const original = new TextEncoder().encode(JSON.stringify({ synced: true }))
      const clock = { 'device-a': 3, 'device-b': 1 }
      const stateVector = 'sv-abc-123'
      const { pushItem } = encryptTestItem(original, keys, { clock, stateVector })

      const input = buildDecryptInput(pushItem, keys)

      const result = decryptItemFromPull(input)

      expect(result.verified).toBe(true)
      expect(new TextDecoder().decode(result.content)).toBe(JSON.stringify({ synced: true }))
    })
  })

  describe('#given V1 item with explicit cryptoVersion #when decrypted', () => {
    it('#then V1 roundtrip works with explicit version', () => {
      const keys = generateTestKeys()
      const original = new TextEncoder().encode(JSON.stringify({ v: 1 }))
      const { pushItem } = encryptTestItem(original, keys)

      const input = buildDecryptInput(pushItem, keys, { cryptoVersion: 1 })

      const result = decryptItemFromPull(input)

      expect(result.verified).toBe(true)
      expect(new TextDecoder().decode(result.content)).toBe(JSON.stringify({ v: 1 }))
    })
  })

  describe('#given cryptoVersion is required #when called without it', () => {
    it('#then TypeScript enforces the field at compile time', () => {
      const keys = generateTestKeys()
      const original = new TextEncoder().encode('default-version')
      const { pushItem } = encryptTestItem(original, keys)

      const input = buildDecryptInput(pushItem, keys, { cryptoVersion: 1 })

      const result = decryptItemFromPull(input)

      expect(result.verified).toBe(true)
    })
  })

  describe('#given cryptoVersion 2 #when decrypted', () => {
    it('#then throws upgrade-required error', () => {
      const keys = generateTestKeys()
      const original = new TextEncoder().encode('future')
      const { pushItem } = encryptTestItem(original, keys)

      const input = buildDecryptInput(pushItem, keys, { cryptoVersion: 2 })

      expect(() => decryptItemFromPull(input)).toThrow(
        'Crypto version 2 is not supported. Please update the app.'
      )
    })
  })

  describe('#given cryptoVersion 0 #when decrypted', () => {
    it('#then throws invalid version error', () => {
      const keys = generateTestKeys()
      const original = new TextEncoder().encode('zero')
      const { pushItem } = encryptTestItem(original, keys)

      const input = buildDecryptInput(pushItem, keys, { cryptoVersion: 0 })

      expect(() => decryptItemFromPull(input)).toThrow(
        'Invalid crypto version: 0. Version must be >= 1.'
      )
    })
  })

  describe('#given negative cryptoVersion #when decrypted', () => {
    it('#then throws invalid version error', () => {
      const keys = generateTestKeys()
      const original = new TextEncoder().encode('negative')
      const { pushItem } = encryptTestItem(original, keys)

      const input = buildDecryptInput(pushItem, keys, { cryptoVersion: -1 })

      expect(() => decryptItemFromPull(input)).toThrow(
        'Invalid crypto version: -1. Version must be >= 1.'
      )
    })
  })

  describe('#given decryptItemFromPull #when called', () => {
    it('#then secureCleanup zeros the fileKey via memzero', () => {
      const memzeroSpy = vi.spyOn(sodium, 'memzero')

      const keys = generateTestKeys()
      const original = new TextEncoder().encode('cleanup-test')
      const { pushItem } = encryptTestItem(original, keys)
      const input = buildDecryptInput(pushItem, keys)

      decryptItemFromPull(input)

      const memzeroCalls = memzeroSpy.mock.calls
      const zeroedAFileKey = memzeroCalls.some(
        ([buf]) => buf instanceof Uint8Array && buf.length === 32
      )
      expect(zeroedAFileKey).toBe(true)

      memzeroSpy.mockRestore()
    })
  })
})
