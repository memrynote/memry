import { beforeAll, describe, expect, it } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'

import { CBOR_FIELD_ORDER } from '@memry/contracts/cbor-ordering'

import { encodeCbor } from './cbor'
import { signPayload, verifySignature } from './signatures'

beforeAll(async () => {
  await sodium.ready
})

const RFC_8032_TEST_1 = {
  seedHex: '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
  publicKeyHex: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
  message: new Uint8Array(),
  signatureHex:
    'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b'
} as const

const fromHex = (hex: string): Uint8Array => sodium.from_hex(hex)

const seedKeyPair = (seedBytes: Uint8Array) => sodium.crypto_sign_seed_keypair(seedBytes)

const deterministicKeyPair = (label: string) => {
  const seed = sodium.crypto_generichash(sodium.crypto_sign_SEEDBYTES, label)
  return seedKeyPair(seed)
}

describe('signatures', () => {
  describe('RFC 8032 §7.1 golden vectors', () => {
    it('matches Test 1 (empty message) bit-exactly via raw sodium primitive', () => {
      // #given — canonical RFC 8032 seed and expected pubkey/signature
      const seed = fromHex(RFC_8032_TEST_1.seedHex)

      // #when — derive keypair and sign the canned (empty) message
      const keyPair = seedKeyPair(seed)
      const signature = sodium.crypto_sign_detached(RFC_8032_TEST_1.message, keyPair.privateKey)

      // #then — public key and signature match the spec byte-for-byte; spec signature verifies
      expect(sodium.to_hex(keyPair.publicKey)).toBe(RFC_8032_TEST_1.publicKeyHex)
      expect(sodium.to_hex(signature)).toBe(RFC_8032_TEST_1.signatureHex)
      expect(
        sodium.crypto_sign_verify_detached(
          fromHex(RFC_8032_TEST_1.signatureHex),
          RFC_8032_TEST_1.message,
          fromHex(RFC_8032_TEST_1.publicKeyHex)
        )
      ).toBe(true)
    })

    it('signPayload is deterministic for a fixed seed + payload (Ed25519 contract)', () => {
      // #given — fixed seed + fixed payload + canonical CBOR field order
      const keyPair = seedKeyPair(fromHex(RFC_8032_TEST_1.seedHex))
      const payload = {
        id: 'item-fixed',
        type: 'task',
        operation: 'create',
        cryptoVersion: 1,
        encryptedKey: 'k',
        keyNonce: 'n',
        encryptedData: 'c',
        dataNonce: 'd'
      }

      // #when — sign twice
      const first = signPayload(payload, CBOR_FIELD_ORDER.SYNC_ITEM, keyPair.privateKey)
      const second = signPayload(payload, CBOR_FIELD_ORDER.SYNC_ITEM, keyPair.privateKey)

      // #then — Ed25519 is deterministic; both signatures verify
      expect(sodium.to_hex(first)).toBe(sodium.to_hex(second))
      expect(verifySignature(payload, CBOR_FIELD_ORDER.SYNC_ITEM, first, keyPair.publicKey)).toBe(
        true
      )
    })
  })

  describe('verifySignature failure modes', () => {
    it('rejects a truncated signature', () => {
      // #given — valid signature over a payload
      const keyPair = deterministicKeyPair('truncated-sig')
      const payload = { id: 'a', type: 'task' }
      const signature = signPayload(payload, CBOR_FIELD_ORDER.SYNC_ITEM, keyPair.privateKey)

      // #when — strip the trailing byte
      const truncated = signature.slice(0, signature.length - 1)

      // #then — verification fails. sodium throws on wrong-length signatures, which we treat as a failed verify.
      let result: boolean
      try {
        result = verifySignature(payload, CBOR_FIELD_ORDER.SYNC_ITEM, truncated, keyPair.publicKey)
      } catch {
        result = false
      }
      expect(result).toBe(false)
    })

    it('rejects a forged signature: signed by key A, presented as if from key B', () => {
      // #given — two distinct keypairs and a payload
      const signer = deterministicKeyPair('signer-a')
      const impersonated = deterministicKeyPair('signer-b')
      const payload = { id: 'forge-me', type: 'task' }

      // #when — A signs, then we attempt to verify using B's public key
      const aSignature = signPayload(payload, CBOR_FIELD_ORDER.SYNC_ITEM, signer.privateKey)
      const verifiedAsImpersonated = verifySignature(
        payload,
        CBOR_FIELD_ORDER.SYNC_ITEM,
        aSignature,
        impersonated.publicKey
      )

      // #then — forgery rejected; A's own pubkey still verifies (sanity)
      expect(verifiedAsImpersonated).toBe(false)
      expect(
        verifySignature(payload, CBOR_FIELD_ORDER.SYNC_ITEM, aSignature, signer.publicKey)
      ).toBe(true)
    })

    it('rejects verification when wrong public key is provided', () => {
      // #given — pair A signs, pair B's pubkey is used for verification
      const pairA = deterministicKeyPair('pair-a')
      const pairB = deterministicKeyPair('pair-b')
      const payload = { id: 'wrong-pubkey', type: 'task', operation: 'update' }
      const signature = signPayload(payload, CBOR_FIELD_ORDER.SYNC_ITEM, pairA.privateKey)

      // #when / #then
      expect(verifySignature(payload, CBOR_FIELD_ORDER.SYNC_ITEM, signature, pairB.publicKey)).toBe(
        false
      )
    })
  })

  describe('tombstone signature regression (server-forged-deletion guard)', () => {
    it('strips deletedAt → signature must fail (prevents server forging deletions)', () => {
      // #given — a tombstone payload signed with deletedAt included in the CBOR-encoded bytes
      const keyPair = deterministicKeyPair('tombstone-device')
      const tombstone = {
        id: 'note-42',
        type: 'note',
        deletedAt: '2026-04-16T12:34:56.000Z',
        deviceId: 'device-abc'
      }
      const signature = signPayload(tombstone, CBOR_FIELD_ORDER.TOMBSTONE, keyPair.privateKey)

      // #when — attacker (or malicious server) strips deletedAt from the payload before re-signing/replaying
      const stripped = { id: tombstone.id, type: tombstone.type, deviceId: tombstone.deviceId }

      // #then — signature does not cover the stripped payload; verification fails
      const verifiedStripped = verifySignature(
        stripped,
        CBOR_FIELD_ORDER.TOMBSTONE,
        signature,
        keyPair.publicKey
      )
      expect(verifiedStripped).toBe(false)

      // #and — the original tombstone (with deletedAt) still verifies, so the field is part of the signed bytes
      expect(
        verifySignature(tombstone, CBOR_FIELD_ORDER.TOMBSTONE, signature, keyPair.publicKey)
      ).toBe(true)
    })

    it('mutating deletedAt to an earlier timestamp invalidates the signature', () => {
      // #given — a signed tombstone
      const keyPair = deterministicKeyPair('tombstone-mutate')
      const tombstone = {
        id: 'note-99',
        type: 'note',
        deletedAt: '2026-04-16T12:34:56.000Z',
        deviceId: 'device-xyz'
      }
      const signature = signPayload(tombstone, CBOR_FIELD_ORDER.TOMBSTONE, keyPair.privateKey)

      // #when — attacker rewinds deletedAt to mask a deletion they want to suppress
      const rewound = { ...tombstone, deletedAt: '2020-01-01T00:00:00.000Z' }

      // #then — signature fails on the mutated payload
      expect(
        verifySignature(rewound, CBOR_FIELD_ORDER.TOMBSTONE, signature, keyPair.publicKey)
      ).toBe(false)
    })

    it('signature covers the exact CBOR-encoded bytes of the field-ordered payload', () => {
      // #given — a tombstone and the canonical encoding of it
      const keyPair = deterministicKeyPair('tombstone-bytes')
      const tombstone = {
        id: 'note-bytes',
        type: 'note',
        deletedAt: '2026-04-16T00:00:00.000Z',
        deviceId: 'device-bytes'
      }
      const encoded = encodeCbor(tombstone, CBOR_FIELD_ORDER.TOMBSTONE)

      // #when — sign through signPayload; verify against the raw-bytes path
      const signature = signPayload(tombstone, CBOR_FIELD_ORDER.TOMBSTONE, keyPair.privateKey)

      // #then — sodium accepts the signature for the same canonical bytes
      expect(sodium.crypto_sign_verify_detached(signature, encoded, keyPair.publicKey)).toBe(true)
    })
  })
})
