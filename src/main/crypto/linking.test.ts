/**
 * Tests for Device Linking Crypto Functions (T109, T110, T110a, T111)
 */

import { describe, it, expect } from 'vitest'
import {
  generateLinkingKeyPair,
  deriveLinkingKeys,
  computeLinkingProof,
  verifyLinkingProof,
  base64ToUint8Array,
  uint8ArrayToBase64
} from './keys'
import { encryptMasterKeyForLinking, decryptMasterKeyFromLinking } from './encryption'
import {
  LINKING_NEW_DEVICE_CONFIRM_FIELD_ORDER,
  LINKING_KEY_CONFIRM_FIELD_ORDER
} from '@shared/contracts/cbor-ordering'

describe('Device Linking Crypto', () => {
  describe('T109: generateLinkingKeyPair', () => {
    it('should generate a valid X25519 keypair with Base64-encoded keys', () => {
      // #when
      const keyPair = generateLinkingKeyPair()

      // #then
      expect(keyPair.publicKey).toBeDefined()
      expect(keyPair.privateKey).toBeDefined()

      const publicKeyBytes = base64ToUint8Array(keyPair.publicKey)
      const privateKeyBytes = base64ToUint8Array(keyPair.privateKey)

      expect(publicKeyBytes.length).toBe(32)
      expect(privateKeyBytes.length).toBe(32)
    })

    it('should generate unique keypairs each time', () => {
      // #when
      const keyPair1 = generateLinkingKeyPair()
      const keyPair2 = generateLinkingKeyPair()

      // #then
      expect(keyPair1.publicKey).not.toBe(keyPair2.publicKey)
      expect(keyPair1.privateKey).not.toBe(keyPair2.privateKey)
    })
  })

  describe('T110: deriveLinkingKeys', () => {
    it('should derive matching keys from ECDH between two parties', async () => {
      // #given
      const aliceKeyPair = generateLinkingKeyPair()
      const bobKeyPair = generateLinkingKeyPair()

      const alicePrivate = base64ToUint8Array(aliceKeyPair.privateKey)
      const alicePublic = base64ToUint8Array(aliceKeyPair.publicKey)
      const bobPrivate = base64ToUint8Array(bobKeyPair.privateKey)
      const bobPublic = base64ToUint8Array(bobKeyPair.publicKey)

      // #when
      const aliceDerived = await deriveLinkingKeys(alicePrivate, bobPublic)
      const bobDerived = await deriveLinkingKeys(bobPrivate, alicePublic)

      // #then
      expect(aliceDerived.encryptionKey.length).toBe(32)
      expect(aliceDerived.macKey.length).toBe(32)

      expect(uint8ArrayToBase64(aliceDerived.encryptionKey)).toBe(
        uint8ArrayToBase64(bobDerived.encryptionKey)
      )
      expect(uint8ArrayToBase64(aliceDerived.macKey)).toBe(uint8ArrayToBase64(bobDerived.macKey))
    })

    it('should throw on invalid key lengths', async () => {
      // #given
      const invalidKey = new Uint8Array(16)
      const validKey = new Uint8Array(32)

      // #then
      await expect(deriveLinkingKeys(invalidKey, validKey)).rejects.toThrow(
        'Invalid private key length'
      )
      await expect(deriveLinkingKeys(validKey, invalidKey)).rejects.toThrow(
        'Invalid public key length'
      )
    })
  })

  describe('T110a: computeLinkingProof / verifyLinkingProof', () => {
    it('should compute deterministic proofs for newDeviceConfirm', async () => {
      // #given
      const keyPair = generateLinkingKeyPair()
      const macKey = new Uint8Array(32)
      for (let i = 0; i < 32; i++) macKey[i] = i

      const payload = {
        sessionId: '123e4567-e89b-12d3-a456-426614174000',
        token: 'secure-random-token-12345678901234567890',
        newDevicePublicKey: keyPair.publicKey
      }

      // #when
      const proof1 = computeLinkingProof(macKey, payload, LINKING_NEW_DEVICE_CONFIRM_FIELD_ORDER)
      const proof2 = computeLinkingProof(macKey, payload, LINKING_NEW_DEVICE_CONFIRM_FIELD_ORDER)

      // #then
      expect(proof1.length).toBe(32)
      expect(uint8ArrayToBase64(proof1)).toBe(uint8ArrayToBase64(proof2))
    })

    it('should verify valid proofs', () => {
      // #given
      const macKey = new Uint8Array(32)
      for (let i = 0; i < 32; i++) macKey[i] = i

      const payload = {
        sessionId: '123e4567-e89b-12d3-a456-426614174000',
        encryptedMasterKey: 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=',
        encryptedKeyNonce: 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4'
      }

      // #when
      const proof = computeLinkingProof(macKey, payload, LINKING_KEY_CONFIRM_FIELD_ORDER)
      const isValid = verifyLinkingProof(macKey, payload, LINKING_KEY_CONFIRM_FIELD_ORDER, proof)

      // #then
      expect(isValid).toBe(true)
    })

    it('should reject tampered proofs', () => {
      // #given
      const macKey = new Uint8Array(32)
      for (let i = 0; i < 32; i++) macKey[i] = i

      const payload = {
        sessionId: '123e4567-e89b-12d3-a456-426614174000',
        token: 'test-token-12345678901234567890123456',
        newDevicePublicKey: 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo='
      }

      const proof = computeLinkingProof(macKey, payload, LINKING_NEW_DEVICE_CONFIRM_FIELD_ORDER)

      // #when - tamper with the proof
      const tamperedProof = new Uint8Array(proof)
      tamperedProof[0] ^= 0xff

      // #then
      const isValid = verifyLinkingProof(
        macKey,
        payload,
        LINKING_NEW_DEVICE_CONFIRM_FIELD_ORDER,
        tamperedProof
      )
      expect(isValid).toBe(false)
    })

    it('should reject proofs with wrong MAC key', () => {
      // #given
      const macKey1 = new Uint8Array(32)
      const macKey2 = new Uint8Array(32)
      for (let i = 0; i < 32; i++) {
        macKey1[i] = i
        macKey2[i] = i + 1
      }

      const payload = {
        sessionId: '123e4567-e89b-12d3-a456-426614174000',
        token: 'test-token-12345678901234567890123456',
        newDevicePublicKey: 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo='
      }

      // #when
      const proof = computeLinkingProof(macKey1, payload, LINKING_NEW_DEVICE_CONFIRM_FIELD_ORDER)

      // #then
      const isValid = verifyLinkingProof(
        macKey2,
        payload,
        LINKING_NEW_DEVICE_CONFIRM_FIELD_ORDER,
        proof
      )
      expect(isValid).toBe(false)
    })
  })

  describe('T111: encryptMasterKeyForLinking / decryptMasterKeyFromLinking', () => {
    it('should encrypt and decrypt master key round-trip', async () => {
      // #given
      const masterKey = new Uint8Array(32)
      for (let i = 0; i < 32; i++) masterKey[i] = i

      const encKey = new Uint8Array(32)
      for (let i = 0; i < 32; i++) encKey[i] = 255 - i

      // #when
      const { ciphertext, nonce } = await encryptMasterKeyForLinking(masterKey, encKey)
      const decrypted = await decryptMasterKeyFromLinking(ciphertext, nonce, encKey)

      // #then
      expect(uint8ArrayToBase64(decrypted)).toBe(uint8ArrayToBase64(masterKey))
    })

    it('should fail decryption with wrong key', async () => {
      // #given
      const masterKey = new Uint8Array(32)
      for (let i = 0; i < 32; i++) masterKey[i] = i

      const encKey1 = new Uint8Array(32)
      const encKey2 = new Uint8Array(32)
      for (let i = 0; i < 32; i++) {
        encKey1[i] = i
        encKey2[i] = i + 1
      }

      // #when
      const { ciphertext, nonce } = await encryptMasterKeyForLinking(masterKey, encKey1)

      // #then
      await expect(decryptMasterKeyFromLinking(ciphertext, nonce, encKey2)).rejects.toThrow()
    })

    it('should work with ECDH-derived keys', async () => {
      // #given
      const aliceKeyPair = generateLinkingKeyPair()
      const bobKeyPair = generateLinkingKeyPair()

      const alicePrivate = base64ToUint8Array(aliceKeyPair.privateKey)
      const bobPrivate = base64ToUint8Array(bobKeyPair.privateKey)
      const alicePublic = base64ToUint8Array(aliceKeyPair.publicKey)
      const bobPublic = base64ToUint8Array(bobKeyPair.publicKey)

      const aliceDerived = await deriveLinkingKeys(alicePrivate, bobPublic)
      const bobDerived = await deriveLinkingKeys(bobPrivate, alicePublic)

      const masterKey = new Uint8Array(32)
      crypto.getRandomValues(masterKey)

      // #when - Alice encrypts with her derived key
      const { ciphertext, nonce } = await encryptMasterKeyForLinking(
        masterKey,
        aliceDerived.encryptionKey
      )

      // #then - Bob decrypts with his derived key
      const decrypted = await decryptMasterKeyFromLinking(
        ciphertext,
        nonce,
        bobDerived.encryptionKey
      )
      expect(uint8ArrayToBase64(decrypted)).toBe(uint8ArrayToBase64(masterKey))
    })
  })

  describe('Full Linking Flow Simulation', () => {
    it('should simulate complete device linking handshake', async () => {
      // Simulate the full flow: existing device (Alice) links new device (Bob)

      // #given - Both devices generate their keypairs
      const aliceKeyPair = generateLinkingKeyPair()
      const bobKeyPair = generateLinkingKeyPair()

      const alicePrivate = base64ToUint8Array(aliceKeyPair.privateKey)
      const bobPrivate = base64ToUint8Array(bobKeyPair.privateKey)
      const alicePublic = base64ToUint8Array(aliceKeyPair.publicKey)
      const bobPublic = base64ToUint8Array(bobKeyPair.publicKey)

      // Simulate master key on Alice's device
      const originalMasterKey = new Uint8Array(32)
      crypto.getRandomValues(originalMasterKey)

      // #when - Step 1: Bob scans QR (gets Alice's public key), derives keys, computes proof
      const bobDerived = await deriveLinkingKeys(bobPrivate, alicePublic)
      const scanPayload = {
        sessionId: '123e4567-e89b-12d3-a456-426614174000',
        token: 'secure-token-from-qr-code-1234567890',
        newDevicePublicKey: bobKeyPair.publicKey
      }
      const bobProof = computeLinkingProof(
        bobDerived.macKey,
        scanPayload,
        LINKING_NEW_DEVICE_CONFIRM_FIELD_ORDER
      )

      // #when - Step 2: Alice verifies Bob's proof, derives keys, encrypts master key
      const aliceDerived = await deriveLinkingKeys(alicePrivate, bobPublic)
      const bobProofValid = verifyLinkingProof(
        aliceDerived.macKey,
        scanPayload,
        LINKING_NEW_DEVICE_CONFIRM_FIELD_ORDER,
        bobProof
      )
      expect(bobProofValid).toBe(true)

      const { ciphertext, nonce } = await encryptMasterKeyForLinking(
        originalMasterKey,
        aliceDerived.encryptionKey
      )

      const approvePayload = {
        sessionId: '123e4567-e89b-12d3-a456-426614174000',
        encryptedMasterKey: uint8ArrayToBase64(ciphertext),
        encryptedKeyNonce: uint8ArrayToBase64(nonce)
      }
      const aliceKeyConfirm = computeLinkingProof(
        aliceDerived.macKey,
        approvePayload,
        LINKING_KEY_CONFIRM_FIELD_ORDER
      )

      // #then - Step 3: Bob verifies Alice's proof and decrypts master key
      const aliceProofValid = verifyLinkingProof(
        bobDerived.macKey,
        approvePayload,
        LINKING_KEY_CONFIRM_FIELD_ORDER,
        aliceKeyConfirm
      )
      expect(aliceProofValid).toBe(true)

      const recoveredMasterKey = await decryptMasterKeyFromLinking(
        ciphertext,
        nonce,
        bobDerived.encryptionKey
      )

      expect(uint8ArrayToBase64(recoveredMasterKey)).toBe(uint8ArrayToBase64(originalMasterKey))
    })
  })
})
