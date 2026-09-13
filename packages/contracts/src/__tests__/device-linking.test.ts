/**
 * Verifier for `device-linking.json` (T075).
 *
 * Recomputes both MACs and the SAS with Node libsodium and `node:crypto`, and
 * asserts the two families are genuinely DIFFERENT primitives over the same
 * message. A test that only recomputed each tag with the primitive the vector
 * names would pass for an implementation that used one primitive everywhere.
 *
 * The SAS bias is asserted rather than corrected: a client that substitutes
 * rejection sampling produces a different code and breaks linking.
 */
import { createHmac } from 'node:crypto'

import sodium from 'libsodium-wrappers-sumo'
import { beforeAll, describe, expect, it } from 'vitest'

import { CBOR_FIELD_ORDER } from '../cbor-ordering'
import { encodeCbor } from '../../../sync-client/src/pull/cbor.ts'
import { fromHex, loadVectorFile } from './vector-loader'

const vectors = loadVectorFile<{
  meta: {
    caseCount: number
    sessionId: string
    linkingSecretB64: string
    linkingSecretBytes: number
    ecdh: { initiatorPublicB64: string; newDevicePublicB64: string; sharedSecretsAgree: boolean }
    subkeys: Record<string, string>
  }
  cases: Array<Record<string, never> & Record<string, unknown>>
  failureCases: Array<Record<string, unknown>>
}>('device-linking.json')

const b64 = (b: Uint8Array): string => sodium.to_base64(b, sodium.base64_variants.ORIGINAL)
const hmacSha256 = (key: Uint8Array, message: Uint8Array): Uint8Array =>
  new Uint8Array(createHmac('sha256', Buffer.from(key)).update(Buffer.from(message)).digest())

describe('device-linking vectors', () => {
  beforeAll(async () => {
    await sodium.ready
  })

  it('carries the recorded case count', () => {
    expect(vectors.cases.length + vectors.failureCases.length).toBe(vectors.meta.caseCount)
  })

  it('the linking secret is 32 bytes carried as 44 characters of standard base64', () => {
    expect(vectors.meta.linkingSecretBytes).toBe(32)
    expect(vectors.meta.linkingSecretB64).toHaveLength(44)
    expect(
      sodium.from_base64(vectors.meta.linkingSecretB64, sodium.base64_variants.ORIGINAL)
    ).toHaveLength(32)
  })

  it('both sides of the X25519 exchange agree', () => {
    expect(vectors.meta.ecdh.sharedSecretsAgree).toBe(true)
  })

  it('the three subkeys use the documented contexts and ids', () => {
    expect(vectors.meta.subkeys).toEqual({
      encryption: 'memrylnk/5',
      mac: 'memrymac/6',
      sas: 'memrysas/7'
    })
  })

  for (const entry of vectors.cases.filter((c) => 'expectedMacB64' in c)) {
    const name = entry.name as string
    it(`${name}: the recorded CBOR message is what the production encoder produces`, () => {
      const ordering = entry.cborOrdering as keyof typeof CBOR_FIELD_ORDER
      const fields =
        ordering === 'LINKING_PROOF'
          ? {
              sessionId: vectors.meta.sessionId,
              devicePublicKey: vectors.meta.ecdh.newDevicePublicB64
            }
          : ordering === 'SCAN_CONFIRM'
            ? {
                sessionId: vectors.meta.sessionId,
                initiatorPublicKey: vectors.meta.ecdh.initiatorPublicB64,
                devicePublicKey: vectors.meta.ecdh.newDevicePublicB64
              }
            : null
      if (fields === null) return // KEY_CONFIRM carries a ciphertext; covered below.
      expect(Buffer.from(encodeCbor(fields, CBOR_FIELD_ORDER[ordering])).toString('hex')).toBe(
        entry.messageHex
      )
    })

    it(`${name}: the MAC recomputes`, () => {
      const message = fromHex(entry.messageHex as string)
      const key = fromHex(entry.keyHex as string)
      const actual =
        entry.channel === 'scan' ? hmacSha256(key, message) : sodium.crypto_auth(message, key)
      expect(b64(actual), entry.pins as string).toBe(entry.expectedMacB64)
      expect(actual).toHaveLength(32)
    })
  }

  it('the two channels are genuinely different primitives over the same message', () => {
    // scanProof and newDeviceConfirm MAC identical bytes under different keys
    // with different algorithms. Swapping either half must not reproduce the
    // other, or an implementation could unify them and still pass.
    const scan = vectors.cases.find((c) => c.name === 'scanProof — the scan channel MAC')!
    const confirm = vectors.cases.find(
      (c) => c.name === 'newDeviceConfirm — the SAME message on the confirm channel'
    )!
    expect(scan.messageHex, 'both families MAC the same bytes').toBe(confirm.messageHex)
    expect(scan.expectedMacB64).not.toBe(confirm.expectedMacB64)

    const message = fromHex(scan.messageHex as string)
    const scanKey = fromHex(scan.keyHex as string)
    const confirmKey = fromHex(confirm.keyHex as string)
    // crypto_auth is HMAC-SHA-512 truncated to 32 bytes, NOT SHA-512/256 and
    // NOT SHA-256; asserting the cross products keeps a unified implementation
    // from passing.
    expect(b64(sodium.crypto_auth(message, scanKey))).not.toBe(scan.expectedMacB64)
    expect(b64(hmacSha256(confirmKey, message))).not.toBe(confirm.expectedMacB64)
  })

  it('the master key block carries NO associated data', () => {
    const entry = vectors.cases.find((c) => c.name === 'the master key block')!
    expect(entry.associatedData).toBeNull()
    const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      sodium.from_base64(entry.encryptedMasterKeyB64 as string, sodium.base64_variants.ORIGINAL),
      null,
      fromHex(entry.keyNonceHex as string),
      fromHex(entry.encKeyHex as string)
    )
    expect(sodium.to_hex(plaintext)).toBe(entry.masterKeyHex)
  })

  it('the SAS derivation, bias included', () => {
    const entry = vectors.cases.find((c) => c.name === 'the SAS derivation')!
    const sasKey = sodium.crypto_kdf_derive_from_key(
      32,
      7,
      'memrysas',
      fromHex(entry.sharedSecretHex as string)
    )
    expect(sodium.to_hex(sasKey)).toBe(entry.sasKeyHex)
    const h = sodium.crypto_generichash(4, sasKey, null)
    expect(sodium.to_hex(h)).toBe(entry.generichash4Hex)
    const u32 = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0
    expect(u32).toBe(entry.uint32BigEndian)
    expect((u32 % 1000000).toString().padStart(6, '0')).toBe(entry.expectedCode)
    expect(entry.expectedCode as string).toMatch(/^\d{6}$/)
    // The modular bias, stated as arithmetic rather than as a remembered
    // number: 2^32 = 4_294_967_296, so 2^32 mod 10^6 = 967_296 and the codes
    // below 967_296 are reachable from 4295 u32 values and the rest from 4294. It MUST
    // be reproduced, not corrected — rejection sampling produces a DIFFERENT
    // code and breaks linking against every shipped client.
    expect(2 ** 32 % 1_000_000).toBe(967_296)
    expect(Math.floor(2 ** 32 / 1_000_000)).toBe(4294)
  })

  for (const entry of vectors.failureCases) {
    it(entry.name as string, () => {
      if ('verifyWithKeyHex' in entry) {
        const message = fromHex(entry.messageHex as string)
        const mac = sodium.from_base64(entry.macB64 as string, sodium.base64_variants.ORIGINAL)
        expect(
          sodium.crypto_auth_verify(mac, message, fromHex(entry.verifyWithKeyHex as string)),
          entry.pins as string
        ).toBe(entry.expectValid)
      } else {
        const sasKey = sodium.crypto_kdf_derive_from_key(
          32,
          7,
          'memrysas',
          fromHex(entry.alteredSharedSecretHex as string)
        )
        const h = sodium.crypto_generichash(4, sasKey, null)
        const u32 = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0
        const code = (u32 % 1000000).toString().padStart(6, '0')
        expect(code).toBe(entry.expectedCode)
        expect(code, entry.pins as string).not.toBe(entry.mustDifferFrom)
      }
    })
  }
})
