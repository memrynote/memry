import { describe, it, expect, beforeAll } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'
import { initCrypto } from '../crypto/index'
import { encryptItemForPush } from './encrypt'
import { decryptItemFromPull, type DecryptItemInput } from './decrypt'

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
    deviceId: 'device-' + sodium.to_hex(sodium.randombytes_buf(4))
  }
}

function simulateServerRoundTrip(pushItem: ReturnType<typeof encryptItemForPush>['pushItem']) {
  const blobJson = JSON.stringify({
    dataNonce: pushItem.dataNonce,
    encryptedData: pushItem.encryptedData,
    encryptedKey: pushItem.encryptedKey,
    keyNonce: pushItem.keyNonce
  })
  const blob = JSON.parse(blobJson) as {
    dataNonce: string
    encryptedData: string
    encryptedKey: string
    keyNonce: string
  }

  const clock = pushItem.clock ? JSON.parse(JSON.stringify(pushItem.clock)) : undefined
  const stateVector = pushItem.stateVector ?? undefined
  const deletedAt = pushItem.deletedAt ?? undefined

  return {
    id: pushItem.id,
    type: pushItem.type,
    operation: pushItem.operation,
    cryptoVersion: 1,
    signature: pushItem.signature,
    signerDeviceId: pushItem.signerDeviceId,
    blob,
    clock,
    stateVector,
    deletedAt
  }
}

function buildDecryptInput(
  serverItem: ReturnType<typeof simulateServerRoundTrip>,
  vaultKey: Uint8Array,
  signerPublicKey: Uint8Array
): DecryptItemInput {
  const item = serverItem
  return {
    id: item.id,
    type: item.type,
    operation: item.operation,
    cryptoVersion: item.cryptoVersion,
    encryptedKey: item.blob.encryptedKey,
    keyNonce: item.blob.keyNonce,
    encryptedData: item.blob.encryptedData,
    dataNonce: item.blob.dataNonce,
    signature: item.signature,
    signerDeviceId: item.signerDeviceId,
    deletedAt: item.deletedAt,
    metadata:
      item.clock || item.stateVector
        ? {
            ...(item.clock ? { clock: item.clock } : {}),
            ...(item.stateVector ? { stateVector: item.stateVector } : {})
          }
        : undefined,
    vaultKey,
    signerPublicKey
  }
}

describe('sign-verify round-trip (simulated server pipeline)', () => {
  describe('#given operation=create with clock', () => {
    it('#then decrypt verifies and round-trips content', () => {
      const keys = generateTestKeys()
      const content = new TextEncoder().encode(JSON.stringify({ title: 'Task A' }))
      const clock = { [keys.deviceId]: 1 }

      const { pushItem } = encryptItemForPush({
        id: 'item-001',
        type: 'task',
        operation: 'create',
        content,
        clock,
        vaultKey: keys.vaultKey,
        signingSecretKey: keys.signingSecretKey,
        signerDeviceId: keys.deviceId
      })

      const serverItem = simulateServerRoundTrip(pushItem)
      const decryptInput = buildDecryptInput(serverItem, keys.vaultKey, keys.signingPublicKey)
      const result = decryptItemFromPull(decryptInput)

      expect(result.verified).toBe(true)
      expect(result.content).toEqual(content)
    })
  })

  describe('#given operation=update with clock', () => {
    it('#then decrypt verifies and round-trips content', () => {
      const keys = generateTestKeys()
      const content = new TextEncoder().encode(JSON.stringify({ title: 'Updated' }))
      const clock = { [keys.deviceId]: 5, 'other-device': 2 }

      const { pushItem } = encryptItemForPush({
        id: 'item-002',
        type: 'note',
        operation: 'update',
        content,
        clock,
        vaultKey: keys.vaultKey,
        signingSecretKey: keys.signingSecretKey,
        signerDeviceId: keys.deviceId
      })

      const serverItem = simulateServerRoundTrip(pushItem)
      const decryptInput = buildDecryptInput(serverItem, keys.vaultKey, keys.signingPublicKey)
      const result = decryptItemFromPull(decryptInput)

      expect(result.verified).toBe(true)
      expect(result.content).toEqual(content)
    })
  })

  describe('#given operation=create without clock (no metadata)', () => {
    it('#then decrypt verifies and round-trips content', () => {
      const keys = generateTestKeys()
      const content = new TextEncoder().encode(JSON.stringify({ name: 'Inbox item' }))

      const { pushItem } = encryptItemForPush({
        id: 'item-003',
        type: 'inbox',
        operation: 'create',
        content,
        vaultKey: keys.vaultKey,
        signingSecretKey: keys.signingSecretKey,
        signerDeviceId: keys.deviceId
      })

      const serverItem = simulateServerRoundTrip(pushItem)
      const decryptInput = buildDecryptInput(serverItem, keys.vaultKey, keys.signingPublicKey)
      const result = decryptItemFromPull(decryptInput)

      expect(result.verified).toBe(true)
      expect(result.content).toEqual(content)
    })
  })

  describe('#given operation=delete with deletedAt and clock', () => {
    it('#then decrypt verifies tombstone', () => {
      const keys = generateTestKeys()
      const content = new TextEncoder().encode('{}')
      const deletedAt = Math.floor(Date.now() / 1000)
      const clock = { [keys.deviceId]: 3 }

      const { pushItem } = encryptItemForPush({
        id: 'item-004',
        type: 'task',
        operation: 'delete',
        content,
        deletedAt,
        clock,
        vaultKey: keys.vaultKey,
        signingSecretKey: keys.signingSecretKey,
        signerDeviceId: keys.deviceId
      })

      const serverItem = simulateServerRoundTrip(pushItem)
      const decryptInput = buildDecryptInput(serverItem, keys.vaultKey, keys.signingPublicKey)
      const result = decryptItemFromPull(decryptInput)

      expect(result.verified).toBe(true)
    })
  })

  describe('#given clock AND stateVector together', () => {
    it('#then decrypt verifies with both in metadata', () => {
      const keys = generateTestKeys()
      const content = new TextEncoder().encode(JSON.stringify({ title: 'Both metadata' }))
      const clock = { [keys.deviceId]: 7 }
      const stateVector = 'sv-abc-123'

      const { pushItem } = encryptItemForPush({
        id: 'item-005',
        type: 'project',
        operation: 'update',
        content,
        clock,
        stateVector,
        vaultKey: keys.vaultKey,
        signingSecretKey: keys.signingSecretKey,
        signerDeviceId: keys.deviceId
      })

      const serverItem = simulateServerRoundTrip(pushItem)
      const decryptInput = buildDecryptInput(serverItem, keys.vaultKey, keys.signingPublicKey)
      const result = decryptItemFromPull(decryptInput)

      expect(result.verified).toBe(true)
      expect(result.content).toEqual(content)
    })
  })

  describe('#given cross-device scenario (different sign and verify keys)', () => {
    it('#then verifies with signers public key', () => {
      const signer = generateTestKeys()
      const content = new TextEncoder().encode(JSON.stringify({ title: 'Cross device' }))
      const clock = { [signer.deviceId]: 1 }

      const { pushItem } = encryptItemForPush({
        id: 'item-006',
        type: 'task',
        operation: 'create',
        content,
        clock,
        vaultKey: signer.vaultKey,
        signingSecretKey: signer.signingSecretKey,
        signerDeviceId: signer.deviceId
      })

      const serverItem = simulateServerRoundTrip(pushItem)
      const decryptInput = buildDecryptInput(serverItem, signer.vaultKey, signer.signingPublicKey)
      const result = decryptItemFromPull(decryptInput)

      expect(result.verified).toBe(true)
      expect(result.content).toEqual(content)
    })
  })

  describe('#given multi-device clock with many entries', () => {
    it('#then JSON round-trip preserves clock object identity', () => {
      const keys = generateTestKeys()
      const content = new TextEncoder().encode(JSON.stringify({ data: 'multi-clock' }))
      const clock = {
        'device-aaa': 10,
        'device-bbb': 5,
        'device-ccc': 1
      }

      const { pushItem } = encryptItemForPush({
        id: 'item-007',
        type: 'settings',
        operation: 'update',
        content,
        clock,
        vaultKey: keys.vaultKey,
        signingSecretKey: keys.signingSecretKey,
        signerDeviceId: keys.deviceId
      })

      const serverItem = simulateServerRoundTrip(pushItem)
      const decryptInput = buildDecryptInput(serverItem, keys.vaultKey, keys.signingPublicKey)
      const result = decryptItemFromPull(decryptInput)

      expect(result.verified).toBe(true)
    })
  })
})
