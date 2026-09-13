/**
 * Desktop's half of the protocol vector gate.
 *
 * `packages/contracts/src/__tests__/*` asserts the `@memry/sync-client` writers
 * against the committed vectors. This file asserts DESKTOP'S writers against
 * the same files. Two implementations of the same envelope live in this
 * repository and nothing else compares them: together these two suites are what
 * keep them byte-identical.
 *
 * WHY IT LIVES HERE and not beside the generator, which
 * `specs/002-native-foundation-ios/contracts/conformance-vectors.md` §5 asks
 * for: `apps/desktop/src/main/sync/encrypt.ts` reaches
 * `apps/desktop/src/main/crypto/primitives.ts` → `memory-lock.ts` →
 * `apps/desktop/src/main/lib/logger.ts` → `electron-log`. Importing it from a
 * `packages/contracts` script would pull Electron into a package that must not
 * depend on an app — the boundary §10 of that same document refuses to breach
 * for the pack writer. The assertion is not lost; it moves to the side of the
 * boundary where desktop's modules are importable.
 *
 * DETERMINISM. Desktop's writers take no injectable seam: they call
 * `generateFileKey()` and `encrypt()`, which draw their own randomness. Rather
 * than widen a production signature for a test, this file stubs
 * `randombytes_buf` BY LENGTH — 32 bytes is the file key, the first 24 is the
 * content nonce, the second is the key-wrap nonce — which is the same
 * "stub the randomness seam, not the algorithm" technique the generator uses,
 * applied at the only seam desktop exposes. Every other libsodium call is real.
 */
import { readFileSync } from 'node:fs'

import sodium from 'libsodium-wrappers-sumo'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const VECTORS = new URL('../../../../../packages/contracts/test-vectors/', import.meta.url)

const load = <T>(name: string): T => JSON.parse(readFileSync(new URL(name, VECTORS), 'utf8')) as T

const fromHex = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, 'hex'))
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')

interface RecordVectors {
  meta: { caseCount: number }
  cases: Array<{
    name: string
    pins: string
    input: {
      id: string
      type: string
      operation: string
      contentUtf8: string
      vaultKeyHex: string
      signingSeedHex: string
      fileKeyHex: string
      dataNonceHex: string
      keyNonceHex: string
      clock: Record<string, number> | null
      stateVector: string | null
      deletedAt: number | null
    }
    expected: { pushItem: Record<string, unknown>; sizeBytes: number }
  }>
}

interface CrdtVectors {
  meta: { layout: { headerBytes: number; signatureOffset: number } }
  cases: Array<{
    name: string
    input: {
      noteId: string
      updateHex: string
      vaultKeyHex: string
      signingSeedHex: string
      fileKeyHex: string
      dataNonceHex: string
      keyNonceHex: string
    }
    expected: { packedHex: string }
  }>
}

interface CborVectors {
  cases: Array<{
    name: string
    fieldOrder: string[]
    input: Record<string, unknown>
    expectedHex: string
  }>
  rejectCases: Array<{ input: Record<string, unknown>; expectErrorContains: string }>
}

interface LinkingVectors {
  meta: { sessionId: string; ecdh: { newDevicePublicB64: string } }
  cases: Array<Record<string, unknown>>
}

/**
 * Install the deterministic randomness seam.
 *
 * Restored after every test, so nothing else in the desktop suite inherits a
 * predictable CSPRNG.
 */
function seedRandomness(fileKeyHex: string, dataNonceHex: string, keyNonceHex: string): void {
  const nonces = [fromHex(dataNonceHex), fromHex(keyNonceHex)]
  let nonceIndex = 0
  vi.spyOn(sodium, 'randombytes_buf').mockImplementation(((length: number) => {
    if (length === 32) return fromHex(fileKeyHex)
    if (length === 24) {
      const next = nonces[Math.min(nonceIndex, nonces.length - 1)]
      nonceIndex += 1
      return next
    }
    throw new Error(`vector-parity: unexpected randombytes_buf(${length})`)
  }) as never)
}

describe('desktop writer parity with the committed protocol vectors', () => {
  beforeAll(async () => {
    await sodium.ready
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('record envelope', () => {
    const vectors = load<RecordVectors>('record-envelope.json')

    for (const entry of vectors.cases) {
      it(`${entry.name}: desktop produces the committed bytes`, async () => {
        const { encryptItemForPush } = await import('./encrypt')
        seedRandomness(entry.input.fileKeyHex, entry.input.dataNonceHex, entry.input.keyNonceHex)
        const signer = sodium.crypto_sign_seed_keypair(fromHex(entry.input.signingSeedHex))

        const { pushItem, sizeBytes } = encryptItemForPush({
          id: entry.input.id,
          type: entry.input.type as never,
          operation: entry.input.operation as never,
          content: new TextEncoder().encode(entry.input.contentUtf8),
          vaultKey: fromHex(entry.input.vaultKeyHex),
          signingSecretKey: signer.privateKey,
          signerDeviceId: entry.expected.pushItem.signerDeviceId as string,
          ...(entry.input.clock ? { clock: entry.input.clock } : {}),
          ...(entry.input.stateVector ? { stateVector: entry.input.stateVector } : {}),
          ...(entry.input.deletedAt !== null ? { deletedAt: entry.input.deletedAt } : {})
        })

        expect(pushItem, entry.pins).toEqual(entry.expected.pushItem)
        expect(sizeBytes).toBe(entry.expected.sizeBytes)
      })
    }
  })

  describe('packed CRDT update', () => {
    const vectors = load<CrdtVectors>('crdt-update.json')

    for (const entry of vectors.cases) {
      it(`${entry.name}: desktop produces the committed packet`, async () => {
        const { encryptCrdtUpdate } = await import('./crdt-encrypt')
        seedRandomness(entry.input.fileKeyHex, entry.input.dataNonceHex, entry.input.keyNonceHex)
        const signer = sodium.crypto_sign_seed_keypair(fromHex(entry.input.signingSeedHex))

        const packed = encryptCrdtUpdate(
          fromHex(entry.input.updateHex),
          fromHex(entry.input.vaultKeyHex),
          entry.input.noteId,
          signer.privateKey
        )
        expect(hex(packed)).toBe(entry.expected.packedHex)
      })
    }

    it('the reader accepts what the writer produced, and rejects a foreign note id', async () => {
      const { decryptCrdtUpdate } = await import('./crdt-encrypt')
      const entry = vectors.cases[0]
      const signer = sodium.crypto_sign_seed_keypair(fromHex(entry.input.signingSeedHex))
      const packed = fromHex(entry.expected.packedHex)

      expect(
        hex(
          decryptCrdtUpdate(
            packed,
            fromHex(entry.input.vaultKeyHex),
            entry.input.noteId,
            signer.publicKey
          )
        )
      ).toBe(entry.input.updateHex)

      expect(() =>
        decryptCrdtUpdate(
          packed,
          fromHex(entry.input.vaultKeyHex),
          'ffffffffffff',
          signer.publicKey
        )
      ).toThrow(/Signature verification failed/)
    })
  })

  describe('canonical CBOR', () => {
    const vectors = load<CborVectors>('cbor-canonical.json')

    /** `Uint8Array` and `undefined` survive the file as tagged objects. */
    const rehydrate = (input: Record<string, unknown>): Record<string, unknown> => {
      const out: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(input)) {
        if (value && typeof value === 'object' && '$bytesHex' in value) {
          out[key] = fromHex((value as { $bytesHex: string }).$bytesHex)
        } else if (value && typeof value === 'object' && '$undefined' in value) {
          out[key] = undefined
        } else {
          out[key] = value
        }
      }
      return out
    }

    for (const entry of vectors.cases) {
      it(`${entry.name}: desktop's encoder agrees byte for byte`, async () => {
        const { encodeCbor } = await import('../crypto/cbor')
        expect(hex(encodeCbor(rehydrate(entry.input), entry.fieldOrder))).toBe(entry.expectedHex)
      })
    }

    for (const entry of vectors.rejectCases) {
      it('desktop rejects a key outside the field order', async () => {
        const { encodeCbor } = await import('../crypto/cbor')
        expect(() => encodeCbor(rehydrate(entry.input), ['id'])).toThrow(entry.expectErrorContains)
      })
    }
  })

  describe('device linking', () => {
    const vectors = load<LinkingVectors>('device-linking.json')

    it('computeLinkingProof reproduces the confirm-channel MAC', async () => {
      const { computeLinkingProof } = await import('../crypto/keys')
      const entry = vectors.cases.find(
        (c) => c.name === 'newDeviceConfirm — the SAME message on the confirm channel'
      )!
      const mac = computeLinkingProof(
        fromHex(entry.keyHex as string),
        vectors.meta.sessionId,
        vectors.meta.ecdh.newDevicePublicB64
      )
      expect(sodium.to_base64(mac, sodium.base64_variants.ORIGINAL)).toBe(entry.expectedMacB64)
    })

    it('computeKeyConfirm reproduces the key-confirm MAC', async () => {
      const { computeKeyConfirm } = await import('../crypto/keys')
      const entry = vectors.cases.find(
        (c) => c.name === 'keyConfirm — the confirm channel over the master key block'
      )!
      const block = vectors.cases.find((c) => c.name === 'the master key block')!
      const mac = computeKeyConfirm(
        fromHex(entry.keyHex as string),
        vectors.meta.sessionId,
        block.encryptedMasterKeyB64 as string
      )
      expect(sodium.to_base64(mac, sodium.base64_variants.ORIGINAL)).toBe(entry.expectedMacB64)
    })

    it('computeVerificationCode reproduces the SAS, bias included', async () => {
      const { computeVerificationCode } = await import('../crypto/keys')
      const entry = vectors.cases.find((c) => c.name === 'the SAS derivation')!
      await expect(computeVerificationCode(fromHex(entry.sharedSecretHex as string))).resolves.toBe(
        entry.expectedCode
      )
    })
  })

  /**
   * The two vault-name cases.
   *
   * They live here rather than in `record-envelope.json` because
   * `vault-name-crypto.ts` is the only implementation of this envelope and it
   * sits behind the same import chain. Both directions are asserted, including
   * the null-on-failure contract that differs from every other envelope in the
   * chapter.
   */
  describe('vault name envelope', () => {
    const VAULT_KEY = '0f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff0'
    const VAULT_UUID = '7f1d2c3b-4a59-4687-9d0e-1f2a3b4c5d6e'
    const NONCE = '000102030405060708090a0b0c0d0e0f1011121314151617'

    it('round-trips a name under its own AAD', async () => {
      const { decryptVaultName, encryptVaultName } = await import('./vault-name-crypto')
      seedRandomness('00'.repeat(32), NONCE, NONCE)
      const { encryptedName, nameNonce } = encryptVaultName(
        'Personal',
        fromHex(VAULT_KEY),
        VAULT_UUID
      )
      expect(decryptVaultName(encryptedName, nameNonce, fromHex(VAULT_KEY), VAULT_UUID)).toBe(
        'Personal'
      )
    })

    it('is bound to its vault uuid through the AAD', async () => {
      const { decryptVaultName, encryptVaultName } = await import('./vault-name-crypto')
      seedRandomness('00'.repeat(32), NONCE, NONCE)
      const { encryptedName, nameNonce } = encryptVaultName(
        'Personal',
        fromHex(VAULT_KEY),
        VAULT_UUID
      )
      // A different vault uuid changes the AAD, so the tag fails.
      expect(
        decryptVaultName(encryptedName, nameNonce, fromHex(VAULT_KEY), 'another-vault'),
        'the AAD binds the name to its vault'
      ).toBeNull()
    })

    it('returns null rather than throwing on a corrupted ciphertext', async () => {
      const { decryptVaultName, encryptVaultName } = await import('./vault-name-crypto')
      seedRandomness('00'.repeat(32), NONCE, NONCE)
      const { encryptedName, nameNonce } = encryptVaultName(
        'Personal',
        fromHex(VAULT_KEY),
        VAULT_UUID
      )
      const corrupted = sodium.from_base64(encryptedName, sodium.base64_variants.ORIGINAL)
      corrupted[0] ^= 0x01

      // The failure contract that differs from every other envelope: null, not
      // a throw. A client that propagates a throw here breaks the vault list.
      expect(
        decryptVaultName(
          sodium.to_base64(corrupted, sodium.base64_variants.ORIGINAL),
          nameNonce,
          fromHex(VAULT_KEY),
          VAULT_UUID
        )
      ).toBeNull()
    })
  })
})
