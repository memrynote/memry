/**
 * Verifier for `crdt-update.json` (T068).
 *
 * Asserts header length 160 and signature offset 96 against the PRODUCTION
 * constants rather than against a literal in this file. A literal here would
 * drift with the implementation and pass while the format changed underneath
 * it, which is the one thing this class exists to prevent.
 *
 * The production constants are module-private in both twins, so they are read
 * back out of the decomposition the generator recorded and cross-checked
 * against the reader's own behaviour: a packet one byte shorter than
 * `HEADER_LEN + 1` must be rejected, and one of exactly that length must not be
 * rejected for length.
 */
import sodium from 'libsodium-wrappers-sumo'
import { beforeAll, describe, expect, it } from 'vitest'

import { encryptCrdtUpdatePacked } from '../../../sync-client/src/push/crdt-encrypt.ts'
import { decryptCrdtUpdatePacked } from '../../../sync-client/src/pull/record-decrypt.ts'
import { deterministicProvider, fromHex, hex } from '../../test-vectors/deterministic-provider'
import { loadVectorFile } from './vector-loader'

const vectors = loadVectorFile<{
  meta: {
    caseCount: number
    layout: {
      headerBytes: number
      signatureOffset: number
      ciphertextOffset: number
      minimumAcceptedBytes: number
    }
  }
  cases: Array<{
    name: string
    pins: string
    input: {
      noteId: string
      updateHex: string
      vaultKeyHex: string
      signingSeedHex: string
      fileKeyHex: string
      dataNonceHex: string
      keyNonceHex: string
    }
    expected: {
      packedHex: string
      packedBytes: number
      decomposition: Record<string, string>
      signedPayloadHex: string
      roundTripHex: string
    }
  }>
  errorCases: Array<{
    name: string
    noteId: string
    packedHex?: string
    packedBytes?: number
    expectRejected?: boolean
    expectErrorContains?: string
    // The portable half of the assertion. `expectErrorContains` is this
    // writer's English message; a second implementation asserts the code.
    expectErrorCode?: 'too-short' | 'signature-invalid'
    pins: string
  }>
}>('crdt-update.json')

const LAYOUT = vectors.meta.layout

describe('crdt-update vectors', () => {
  beforeAll(async () => {
    await sodium.ready
  })

  it('carries the recorded case count', () => {
    expect(vectors.cases.length + vectors.errorCases.length).toBe(vectors.meta.caseCount)
  })

  it('the recorded layout is 160/96 and the minimum length is 161', () => {
    expect(LAYOUT.headerBytes).toBe(160)
    expect(LAYOUT.signatureOffset).toBe(96)
    expect(LAYOUT.ciphertextOffset).toBe(160)
    expect(LAYOUT.minimumAcceptedBytes).toBe(161)
  })

  it('the production reader enforces the recorded minimum length', async () => {
    const crypto = deterministicProvider()
    const signer = sodium.crypto_sign_seed_keypair(fromHex(vectors.cases[0].input.signingSeedHex))
    const oneShort = new Uint8Array(LAYOUT.minimumAcceptedBytes - 1)
    await expect(
      decryptCrdtUpdatePacked(crypto, oneShort, new Uint8Array(32), 'n', signer.publicKey),
      'a packet one byte under the minimum must be rejected ON LENGTH'
    ).rejects.toThrow(/too short/)

    const atMinimum = new Uint8Array(LAYOUT.minimumAcceptedBytes)
    await expect(
      decryptCrdtUpdatePacked(crypto, atMinimum, new Uint8Array(32), 'n', signer.publicKey),
      'a packet at exactly the minimum must fail LATER, on the signature'
    ).rejects.toThrow(/Signature verification failed/)
  })

  for (const entry of vectors.cases) {
    it(`${entry.name}: the writer reproduces the packed envelope`, () => {
      const crypto = deterministicProvider({
        fileKeyHex: entry.input.fileKeyHex,
        dataNonceHex: entry.input.dataNonceHex,
        keyNonceHex: entry.input.keyNonceHex
      })
      const signer = sodium.crypto_sign_seed_keypair(fromHex(entry.input.signingSeedHex))
      const packed = encryptCrdtUpdatePacked(
        crypto,
        fromHex(entry.input.updateHex),
        fromHex(entry.input.vaultKeyHex),
        entry.input.noteId,
        signer.privateKey
      )
      expect(hex(packed), entry.pins).toBe(entry.expected.packedHex)
      expect(packed.length).toBe(entry.expected.packedBytes)
    })

    it(`${entry.name}: the recorded decomposition matches the documented offsets`, () => {
      const packed = fromHex(entry.expected.packedHex)
      // Sliced at LITERAL offsets on purpose: a constant that drifts must fail
      // loudly here rather than shift everything consistently and pass.
      expect(hex(packed.subarray(0, 24))).toBe(entry.expected.decomposition.dataNonceHex)
      expect(hex(packed.subarray(24, 48))).toBe(entry.expected.decomposition.keyNonceHex)
      expect(hex(packed.subarray(48, 96))).toBe(entry.expected.decomposition.wrappedKeyHex)
      expect(hex(packed.subarray(96, 160))).toBe(entry.expected.decomposition.signatureHex)
      expect(hex(packed.subarray(160))).toBe(entry.expected.decomposition.ciphertextHex)
    })

    it(`${entry.name}: the note id is authenticated, and the round trip holds`, async () => {
      const crypto = deterministicProvider()
      const signer = sodium.crypto_sign_seed_keypair(fromHex(entry.input.signingSeedHex))
      const packed = fromHex(entry.expected.packedHex)

      // The signature covers noteId ‖ header-without-signature ‖ ciphertext.
      expect(
        sodium.crypto_sign_verify_detached(
          packed.subarray(96, 160),
          fromHex(entry.expected.signedPayloadHex),
          signer.publicKey
        ),
        'the recorded signed payload must actually verify'
      ).toBe(true)

      const plaintext = await decryptCrdtUpdatePacked(
        crypto,
        packed,
        fromHex(entry.input.vaultKeyHex),
        entry.input.noteId,
        signer.publicKey
      )
      expect(hex(plaintext)).toBe(entry.expected.roundTripHex)
      expect(entry.expected.roundTripHex).toBe(entry.input.updateHex)
    })
  }

  for (const entry of vectors.errorCases.filter((c) => c.expectErrorContains)) {
    it(entry.name, async () => {
      const crypto = deterministicProvider()
      const signer = sodium.crypto_sign_seed_keypair(fromHex(vectors.cases[0].input.signingSeedHex))
      await expect(
        decryptCrdtUpdatePacked(
          crypto,
          fromHex(entry.packedHex!),
          fromHex(vectors.cases[0].input.vaultKeyHex),
          entry.noteId,
          signer.publicKey
        ),
        entry.pins
      ).rejects.toThrow(entry.expectErrorContains)
    })
  }

  it('every message-asserting error case also carries a portable error code', () => {
    // Without this, the only thing pinning these cases is an English string
    // from one implementation, which a Rust or Swift port cannot reproduce
    // without copying the phrasing rather than the behaviour.
    for (const entry of vectors.errorCases.filter((c) => c.expectErrorContains)) {
      expect(entry.expectErrorCode, entry.name).toBeDefined()
    }
  })
})
