/**
 * Verifier for `delete-attestation.json` (#2408, chapter 04 §4.8.4).
 *
 * Reads the committed file and runs the production encoder and the shared
 * eligibility rule over it. It never imports the builder (README rule 2).
 */
import { describe, expect, it } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'

import { deleteAttestationMessage } from '../../../sync-client/src/push/record-encrypt.ts'
import { encodeCbor } from '../../../sync-client/src/pull/cbor.ts'
import { CBOR_FIELD_ORDER } from '../cbor-ordering'
import {
  DELETE_ATTESTATION_PURPOSE,
  deleteAttestationPayload,
  deleteClaimOf,
  type DeleteClaim
} from '../delete-attestation'
import { fromHex, hex, loadVectorFile } from './vector-loader'

interface Case {
  name: string
  claim: DeleteClaim
  messageHex: string
  signatureB64: string
}

const vectors = loadVectorFile<{
  meta: { purpose: string; fieldOrder: string[]; signerPublicKeyB64: string; caseCount: number }
  cases: Case[]
  mutations: Array<{
    name: string
    claim: DeleteClaim
    signerPublicKeyB64: string
    signatureB64: string
  }>
  claimOf: Array<{
    name: string
    input: Parameters<typeof deleteClaimOf>[0]
    claim: DeleteClaim | null
  }>
}>('delete-attestation.json')

await sodium.ready
const fromB64 = (value: string) => sodium.from_base64(value, sodium.base64_variants.ORIGINAL)
const verifies = (signatureB64: string, message: Uint8Array, publicKeyB64: string) =>
  sodium.crypto_sign_verify_detached(fromB64(signatureB64), message, fromB64(publicKeyB64))

describe('delete-attestation.json (#2408)', () => {
  it('pins the purpose and the allowlist the file was generated under', () => {
    expect(vectors.meta.purpose).toBe(DELETE_ATTESTATION_PURPOSE)
    expect(vectors.meta.fieldOrder).toEqual([...CBOR_FIELD_ORDER.DELETE_ATTESTATION])
    expect(vectors.cases).toHaveLength(vectors.meta.caseCount)
  })

  it.each(vectors.cases.map((c) => [c.name, c] as const))(
    '%s: the production encoder reproduces the message, and the signature verifies',
    (_name, entry) => {
      const message = deleteAttestationMessage(entry.claim)
      expect(hex(message)).toBe(entry.messageHex)
      expect(
        verifies(entry.signatureB64, fromHex(entry.messageHex), vectors.meta.signerPublicKeyB64)
      ).toBe(true)
      expect(fromB64(entry.signatureB64)).toHaveLength(64)
    }
  )

  it('gives one message for one clock in two insertion orders', () => {
    const [first, second] = vectors.cases
    expect(Object.keys(first.claim.clock)).not.toEqual(Object.keys(second.claim.clock))
    expect(first.messageHex).toBe(second.messageHex)
  })

  it('signs a millisecond deletedAt as an 8-byte unsigned integer', () => {
    const ms = vectors.cases.find((c) => c.claim.deletedAt > 1e12)!
    expect(ms.messageHex).toContain('6964656c6574656441741b')
  })

  it.each(vectors.mutations.map((m) => [m.name, m] as const))(
    'refuses a mutation: %s',
    (_name, mutation) => {
      expect(
        verifies(
          mutation.signatureB64,
          deleteAttestationMessage(mutation.claim),
          mutation.signerPublicKeyB64
        )
      ).toBe(false)
    }
  )

  it.each(vectors.claimOf.map((c) => [c.name, c] as const))('deleteClaimOf: %s', (_name, entry) => {
    expect(deleteClaimOf(entry.input)).toEqual(entry.claim)
  })

  // Domain separation: no item signer can ever sign an attestation, because
  // the SYNC_ITEM allowlist rejects `purpose`, and the attestation allowlist
  // rejects every payload field.
  it('keeps the attestation and the item signature payloads disjoint', () => {
    const payload = deleteAttestationPayload(vectors.cases[0].claim)
    expect(() => encodeCbor(payload, CBOR_FIELD_ORDER.SYNC_ITEM)).toThrow(/purpose/)
    expect(() =>
      encodeCbor({ ...payload, encryptedData: 'x' }, CBOR_FIELD_ORDER.DELETE_ATTESTATION)
    ).toThrow(/encryptedData/)
  })
})
