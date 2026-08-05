import { beforeAll, describe, expect, it } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'
import { CBOR_FIELD_ORDER } from '@memry/contracts/cbor-ordering'
import { initCrypto } from '../crypto/index'
import { encrypt, wrapFileKey } from '../crypto/encryption'
import { generateFileKey } from '../crypto/primitives'
import { signPayload } from '../crypto/signatures'
import { compressPayload } from './compress'
import { encryptItemForPush } from './encrypt'
import { decryptSingleItem } from './decrypt-item'
import type { PullItemForDecrypt } from './worker-protocol'

// decryptSingleItem is the trust boundary for everything the server hands us.
// It must NEVER throw (a throw inside the pull loop aborts the whole page and
// strands every later item) and must NEVER return partial plaintext. The
// failure flags it sets are load-bearing downstream:
//   isSignatureError -> pull-coordinator quarantines the item
//   isCryptoError    -> counted toward the page-wide crypto failure that
//                       triggers the account-key mismatch check
// See engine/pull-coordinator.ts.

beforeAll(async () => {
  await initCrypto()
})

interface TestKeys {
  vaultKey: Uint8Array
  signingSecretKey: Uint8Array
  signingPublicKey: Uint8Array
  deviceId: string
}

function generateTestKeys(deviceId = 'device-a'): TestKeys {
  const keyPair = sodium.crypto_sign_keypair()
  return {
    vaultKey: sodium.randombytes_buf(32),
    signingSecretKey: keyPair.privateKey,
    signingPublicKey: keyPair.publicKey,
    deviceId
  }
}

function makePullItem(
  keys: TestKeys,
  content: string,
  overrides: Partial<PullItemForDecrypt> = {},
  encryptOverrides: Record<string, unknown> = {}
): PullItemForDecrypt {
  const { pushItem } = encryptItemForPush({
    id: 'item-1',
    type: 'note',
    operation: 'update',
    content: new TextEncoder().encode(content),
    vaultKey: keys.vaultKey,
    signingSecretKey: keys.signingSecretKey,
    signerDeviceId: keys.deviceId,
    ...encryptOverrides
  })

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
    ...(pushItem.clock && { clock: pushItem.clock }),
    ...(pushItem.stateVector && { stateVector: pushItem.stateVector }),
    ...(pushItem.deletedAt !== undefined && { deletedAt: pushItem.deletedAt }),
    ...overrides
  }
}

describe('decryptSingleItem', () => {
  describe('#given a well-formed item #when decrypted with the right keys', () => {
    it('#then returns the plaintext with the item identity preserved', () => {
      const keys = generateTestKeys()
      const body = JSON.stringify({ title: 'Quarterly plan' })
      const item = makePullItem(keys, body)

      const result = decryptSingleItem(item, keys.vaultKey, keys.signingPublicKey)

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.item).toEqual({
        id: 'item-1',
        type: 'note',
        operation: 'update',
        content: body,
        clock: undefined,
        deletedAt: undefined,
        signerDeviceId: 'device-a'
      })
    })

    it('#then a payload larger than the compression threshold round-trips intact', () => {
      const keys = generateTestKeys()
      const body = JSON.stringify({ content: 'lorem ipsum '.repeat(5000) })
      const item = makePullItem(keys, body)

      const result = decryptSingleItem(item, keys.vaultKey, keys.signingPublicKey)

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.item.content).toBe(body)
    })

    it('#then the signed clock metadata is carried through to the applier', () => {
      const keys = generateTestKeys()
      const clock = { 'device-a': 4, 'device-b': 2 }
      const item = makePullItem(keys, '{}', { clock }, { clock })

      const result = decryptSingleItem(item, keys.vaultKey, keys.signingPublicKey)

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.item.clock).toEqual(clock)
    })
  })

  describe('#given a tombstone #when decrypted', () => {
    it('#then the operation is forced to delete regardless of the declared operation', () => {
      const keys = generateTestKeys()
      const deletedAt = 1_770_000_000_000
      const item = makePullItem(keys, '{}', { operation: 'update', deletedAt }, { deletedAt })

      const result = decryptSingleItem(item, keys.vaultKey, keys.signingPublicKey)

      expect(result.ok).toBe(true)
      if (!result.ok) return
      // A tombstone mis-applied as an update resurrects a deleted item on the
      // pulling device.
      expect(result.item.operation).toBe('delete')
      expect(result.item.deletedAt).toBe(deletedAt)
    })
  })

  describe('#given a payload encrypted with a DIFFERENT vault key #when decrypted', () => {
    it('#then fails cleanly as a crypto error, not a signature error', () => {
      // The "wrong key after re-provisioning" incident class: the signature
      // still verifies (same signing device) but the file key cannot be
      // unwrapped. It MUST NOT be reported as a signature error, or every item
      // in the vault gets quarantined instead of raising a key mismatch.
      const keys = generateTestKeys()
      const otherVaultKey = sodium.randombytes_buf(32)
      const item = makePullItem(keys, JSON.stringify({ secret: true }))

      const result = decryptSingleItem(item, otherVaultKey, keys.signingPublicKey)

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.failure.isCryptoError).toBe(true)
      expect(result.failure.isSignatureError).toBe(false)
      expect(result.failure.id).toBe('item-1')
      expect(result.failure.type).toBe('note')
      expect(result.failure.signerDeviceId).toBe('device-a')
      expect(result.failure.error).toBeTruthy()
    })

    it('#then no plaintext leaks into the failure result', () => {
      const keys = generateTestKeys()
      const otherVaultKey = sodium.randombytes_buf(32)
      const item = makePullItem(keys, JSON.stringify({ secret: 'topsecret-marker' }))

      const result = decryptSingleItem(item, otherVaultKey, keys.signingPublicKey)

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result).not.toHaveProperty('item')
      expect(JSON.stringify(result)).not.toContain('topsecret-marker')
    })

    it('#then a wrong-length vault key fails cleanly rather than throwing', () => {
      const keys = generateTestKeys()
      const item = makePullItem(keys, '{}')

      const result = decryptSingleItem(item, new Uint8Array(16), keys.signingPublicKey)

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.failure.isCryptoError).toBe(true)
    })
  })

  describe('#given an item signed by a foreign device #when decrypted', () => {
    it('#then reports a signature error so the item is quarantined', () => {
      const keys = generateTestKeys()
      const foreign = generateTestKeys('device-evil')
      const item = makePullItem(keys, '{}')

      const result = decryptSingleItem(item, keys.vaultKey, foreign.signingPublicKey)

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.failure.isSignatureError).toBe(true)
      expect(result.failure.isCryptoError).toBe(true)
    })
  })

  describe('#given tampered or truncated ciphertext #when decrypted', () => {
    it('#then a mutated ciphertext is rejected before any decryption is attempted', () => {
      const keys = generateTestKeys()
      const item = makePullItem(keys, JSON.stringify({ amount: 1 }))
      const tampered: PullItemForDecrypt = {
        ...item,
        encryptedData: item.encryptedData.slice(0, -4) + 'AAAA'
      }

      const result = decryptSingleItem(tampered, keys.vaultKey, keys.signingPublicKey)

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.failure.isSignatureError).toBe(true)
    })

    it('#then a truncated ciphertext fails without throwing', () => {
      const keys = generateTestKeys()
      const item = makePullItem(keys, JSON.stringify({ body: 'x'.repeat(500) }))
      const truncated: PullItemForDecrypt = {
        ...item,
        encryptedData: item.encryptedData.slice(0, 24)
      }

      expect(() => decryptSingleItem(truncated, keys.vaultKey, keys.signingPublicKey)).not.toThrow()
      const result = decryptSingleItem(truncated, keys.vaultKey, keys.signingPublicKey)
      expect(result.ok).toBe(false)
    })

    it('#then non-base64 garbage in every crypto field fails without throwing', () => {
      const keys = generateTestKeys()
      const item = makePullItem(keys, '{}')

      for (const field of [
        'encryptedKey',
        'keyNonce',
        'encryptedData',
        'dataNonce',
        'signature'
      ] as const) {
        const corrupted: PullItemForDecrypt = { ...item, [field]: '!!! not base64 !!!' }

        let result: ReturnType<typeof decryptSingleItem> | undefined
        expect(() => {
          result = decryptSingleItem(corrupted, keys.vaultKey, keys.signingPublicKey)
        }, field).not.toThrow()
        expect(result?.ok, field).toBe(false)
      }
    })

    it('#then a swapped nonce fails as a crypto error, not silently', () => {
      const keys = generateTestKeys()
      const a = makePullItem(keys, '{"a":1}')
      const b = makePullItem(keys, '{"b":2}')
      // dataNonce is covered by the signature, so swapping it trips the
      // signature check first — the important part is that it never decodes
      // into the wrong item's plaintext.
      const swapped: PullItemForDecrypt = { ...a, dataNonce: b.dataNonce }

      const result = decryptSingleItem(swapped, keys.vaultKey, keys.signingPublicKey)

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.failure.isCryptoError).toBe(true)
    })
  })

  describe('#given signed metadata is altered in transit #when decrypted', () => {
    it('#then a rewritten clock is rejected as a signature error', () => {
      // The vector clock is inside the signature payload: a server (or MITM)
      // that rewrites the clock to win a merge must not be able to.
      const keys = generateTestKeys()
      const item = makePullItem(
        keys,
        '{}',
        { clock: { 'device-a': 1 } },
        { clock: { 'device-a': 1 } }
      )
      const rewritten: PullItemForDecrypt = { ...item, clock: { 'device-a': 999 } }

      const result = decryptSingleItem(rewritten, keys.vaultKey, keys.signingPublicKey)

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.failure.isSignatureError).toBe(true)
    })

    it('#then a stripped clock is rejected as a signature error', () => {
      const keys = generateTestKeys()
      const item = makePullItem(
        keys,
        '{}',
        { clock: { 'device-a': 3 } },
        { clock: { 'device-a': 3 } }
      )
      const stripped: PullItemForDecrypt = { ...item }
      delete stripped.clock

      const result = decryptSingleItem(stripped, keys.vaultKey, keys.signingPublicKey)

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.failure.isSignatureError).toBe(true)
    })

    it('#then an injected deletedAt is rejected as a signature error', () => {
      // Otherwise anyone able to add a field to a pull response could
      // tombstone another device's data.
      const keys = generateTestKeys()
      const item = makePullItem(keys, '{}')
      const forged: PullItemForDecrypt = { ...item, deletedAt: Date.now() }

      const result = decryptSingleItem(forged, keys.vaultKey, keys.signingPublicKey)

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.failure.isSignatureError).toBe(true)
    })
  })

  describe('#given a well-signed item whose compressed body is truncated #when decrypted', () => {
    /**
     * Builds a pull item the normal way but with a deliberately short deflate
     * stream inside the (valid, authenticated) ciphertext — the shape a
     * writer-side truncation bug produces. The AEAD tag and signature both
     * verify; only the compressed body is short.
     */
    function makeTruncatedBodyItem(keys: TestKeys): PullItemForDecrypt {
      const compressed = compressPayload(
        new TextEncoder().encode(JSON.stringify({ title: 'Important', body: 'x'.repeat(20_000) }))
      )
      const truncated = compressed.slice(0, Math.floor(compressed.byteLength / 2))

      const fileKey = generateFileKey()
      const { ciphertext, nonce: dataNonce } = encrypt(truncated, fileKey)
      const { wrappedKey, nonce: keyNonce } = wrapFileKey(fileKey, keys.vaultKey)
      const toB64 = (bytes: Uint8Array): string =>
        sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL)

      const signaturePayload = {
        id: 'item-1',
        type: 'note',
        operation: 'update',
        cryptoVersion: 1,
        encryptedKey: toB64(wrappedKey),
        keyNonce: toB64(keyNonce),
        encryptedData: toB64(ciphertext),
        dataNonce: toB64(dataNonce)
      }

      return {
        ...signaturePayload,
        signature: toB64(
          signPayload(signaturePayload, CBOR_FIELD_ORDER.SYNC_ITEM, keys.signingSecretKey)
        ),
        signerDeviceId: keys.deviceId
      }
    }

    // Root cause in compress.ts (see compress.test.ts): pako returns
    // `undefined` for an incomplete deflate stream instead of throwing. If that
    // leaks through, this path reports a SUCCESSFUL decrypt of an empty item,
    // and applying it as an update wipes the note's content on every device.
    // Decrypt failures must be typed failures; "" is not a decrypt result.
    it('#then it is reported as a failure, not as an empty success', () => {
      const keys = generateTestKeys()

      const result = decryptSingleItem(
        makeTruncatedBodyItem(keys),
        keys.vaultKey,
        keys.signingPublicKey
      )

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.failure.error).toMatch(/decompress/i)
    })

    it('#then the failure is not misreported as a signature or key problem', () => {
      // The signature verifies and the AEAD tag verifies — only the compressed
      // body is short. Flagging it as a signature error would quarantine the
      // item; flagging it as a crypto error would push the page toward the
      // account-key mismatch path. Neither is true here.
      const keys = generateTestKeys()

      const result = decryptSingleItem(
        makeTruncatedBodyItem(keys),
        keys.vaultKey,
        keys.signingPublicKey
      )

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.failure.isSignatureError).toBe(false)
      expect(result.failure.isCryptoError).toBe(false)
      expect(result.failure.id).toBe('item-1')
    })
  })

  describe('#given an unsupported crypto version #when decrypted', () => {
    it('#then fails as a plain (non-crypto) failure so the item is not quarantined', () => {
      // A newer-format item from an upgraded device should make this device
      // retry after updating, NOT brand the item corrupt forever.
      const keys = generateTestKeys()
      const item = makePullItem(keys, '{}', { cryptoVersion: 2 })

      const result = decryptSingleItem(item, keys.vaultKey, keys.signingPublicKey)

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.failure.error).toContain('Crypto version 2 is not supported')
      expect(result.failure.isSignatureError).toBe(false)
      expect(result.failure.isCryptoError).toBe(false)
    })

    it('#then a zero/negative crypto version fails cleanly', () => {
      const keys = generateTestKeys()

      for (const cryptoVersion of [0, -1]) {
        const result = decryptSingleItem(
          makePullItem(keys, '{}', { cryptoVersion }),
          keys.vaultKey,
          keys.signingPublicKey
        )

        expect(result.ok).toBe(false)
        if (result.ok) continue
        expect(result.failure.error).toContain('Invalid crypto version')
      }
    })
  })
})
