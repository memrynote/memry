import { describe, it, expect, beforeAll, vi } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'
import { initCrypto } from '../crypto/index'
import { decrypt, unwrapFileKey } from '../crypto/encryption'
import { verifySignature } from '../crypto/signatures'
import { CBOR_FIELD_ORDER } from '@memry/contracts/cbor-ordering'
import { encryptItemForPush, type EncryptItemInput } from './encrypt'
import { decompressPayload } from './compress'

beforeAll(async () => {
  await initCrypto()
})

function generateTestKeys() {
  const vaultKey = sodium.randombytes_buf(32)
  const keyPair = sodium.crypto_sign_keypair()
  return {
    vaultKey,
    signingSecretKey: keyPair.privateKey,
    signingPublicKey: keyPair.publicKey,
    deviceId: 'test-device-1'
  }
}

function makeInput(overrides?: Partial<EncryptItemInput>): EncryptItemInput {
  const keys = generateTestKeys()
  return {
    id: 'note-abc-123',
    type: 'note',
    operation: 'create',
    content: new TextEncoder().encode(JSON.stringify({ title: 'Hello', body: 'World' })),
    vaultKey: keys.vaultKey,
    signingSecretKey: keys.signingSecretKey,
    signerDeviceId: keys.deviceId,
    ...overrides
  }
}

describe('encryptItemForPush', () => {
  describe('#given valid input #when encryptItemForPush', () => {
    it('#then returns PushItem with all fields populated', () => {
      const input = makeInput()
      const result = encryptItemForPush(input)

      expect(result.pushItem.id).toBe(input.id)
      expect(result.pushItem.type).toBe(input.type)
      expect(result.pushItem.operation).toBe(input.operation)
      expect(result.pushItem.signerDeviceId).toBe(input.signerDeviceId)
      expect(result.pushItem.encryptedKey).toBeTruthy()
      expect(result.pushItem.keyNonce).toBeTruthy()
      expect(result.pushItem.encryptedData).toBeTruthy()
      expect(result.pushItem.dataNonce).toBeTruthy()
      expect(result.pushItem.signature).toBeTruthy()
    })

    it('#then sizeBytes matches ciphertext length', () => {
      const result = encryptItemForPush(makeInput())

      const ciphertextBytes = sodium.from_base64(
        result.pushItem.encryptedData,
        sodium.base64_variants.ORIGINAL
      )
      expect(result.sizeBytes).toBe(ciphertextBytes.length)
    })
  })

  describe('#given input with clock and stateVector #when encryptItemForPush', () => {
    it('#then PushItem includes them', () => {
      const clock = { 'device-a': 3, 'device-b': 1 }
      const stateVector = 'sv-abc-123'
      const result = encryptItemForPush(makeInput({ clock, stateVector }))

      expect(result.pushItem.clock).toEqual(clock)
      expect(result.pushItem.stateVector).toBe(stateVector)
    })
  })

  describe('#given input with deletedAt (tombstone) #when encryptItemForPush', () => {
    it('#then pushItem includes deletedAt in wire format', () => {
      const deletedAt = Math.floor(Date.now() / 1000)
      const result = encryptItemForPush(makeInput({ deletedAt }))

      expect(result.pushItem.deletedAt).toBe(deletedAt)
    })

    it('#then pushItem omits deletedAt when not provided', () => {
      const result = encryptItemForPush(makeInput())

      expect(result.pushItem.deletedAt).toBeUndefined()
    })

    it('#then signature includes deletedAt', () => {
      const keys = generateTestKeys()
      const deletedAt = Date.now()
      const result = encryptItemForPush(
        makeInput({
          deletedAt,
          vaultKey: keys.vaultKey,
          signingSecretKey: keys.signingSecretKey,
          signerDeviceId: keys.deviceId
        })
      )

      const signaturePayload: Record<string, unknown> = {
        id: 'note-abc-123',
        type: 'note',
        operation: 'create',
        cryptoVersion: 1,
        encryptedKey: result.pushItem.encryptedKey,
        keyNonce: result.pushItem.keyNonce,
        encryptedData: result.pushItem.encryptedData,
        dataNonce: result.pushItem.dataNonce,
        deletedAt
      }

      const sigBytes = sodium.from_base64(
        result.pushItem.signature,
        sodium.base64_variants.ORIGINAL
      )
      const valid = verifySignature(
        signaturePayload,
        CBOR_FIELD_ORDER.SYNC_ITEM,
        sigBytes,
        keys.signingPublicKey
      )
      expect(valid).toBe(true)
    })
  })

  describe('#given encryptItemForPush result #when decrypted with correct keys', () => {
    it('#then round-trips to original content', () => {
      const keys = generateTestKeys()
      const originalContent = new TextEncoder().encode(
        JSON.stringify({ title: 'Round trip', body: 'Test content' })
      )

      const result = encryptItemForPush(
        makeInput({
          content: originalContent,
          vaultKey: keys.vaultKey,
          signingSecretKey: keys.signingSecretKey,
          signerDeviceId: keys.deviceId
        })
      )

      const fromB64 = (s: string): Uint8Array =>
        sodium.from_base64(s, sodium.base64_variants.ORIGINAL)

      const sigBytes = fromB64(result.pushItem.signature)
      const signaturePayload: Record<string, unknown> = {
        id: result.pushItem.id,
        type: result.pushItem.type,
        operation: result.pushItem.operation,
        cryptoVersion: 1,
        encryptedKey: result.pushItem.encryptedKey,
        keyNonce: result.pushItem.keyNonce,
        encryptedData: result.pushItem.encryptedData,
        dataNonce: result.pushItem.dataNonce
      }
      expect(
        verifySignature(
          signaturePayload,
          CBOR_FIELD_ORDER.SYNC_ITEM,
          sigBytes,
          keys.signingPublicKey
        )
      ).toBe(true)

      const fileKey = unwrapFileKey(
        fromB64(result.pushItem.encryptedKey),
        fromB64(result.pushItem.keyNonce),
        keys.vaultKey
      )

      const plaintext = decompressPayload(
        decrypt(fromB64(result.pushItem.encryptedData), fromB64(result.pushItem.dataNonce), fileKey)
      )

      expect(plaintext).toEqual(originalContent)
    })
  })

  describe('#given encryptItemForPush #when fileKey cleanup', () => {
    it('#then secureCleanup zeroes the fileKey via sodium.memzero', () => {
      const spy = vi.spyOn(sodium, 'memzero')

      encryptItemForPush(makeInput())

      expect(spy).toHaveBeenCalled()
      const zeroedBuffer = spy.mock.calls[0][0] as Uint8Array
      expect(zeroedBuffer.length).toBe(32)
      expect(zeroedBuffer.every((b) => b === 0)).toBe(true)

      spy.mockRestore()
    })
  })
})
