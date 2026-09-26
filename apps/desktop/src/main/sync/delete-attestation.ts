import sodium from 'libsodium-wrappers-sumo'
import { CBOR_FIELD_ORDER } from '@memry/contracts/cbor-ordering'
import { deleteAttestationPayload, type DeleteClaim } from '@memry/contracts/delete-attestation'
import { verifySignature } from '../crypto/signatures'

/** The attestation fields of a purged tombstone entry, present only together (#2408). */
export interface TombstoneAttestation {
  signerDeviceId: string
  signature: string
}

declare const verified: unique symbol

/**
 * Proof that the named device signed this exact delete claim (protocol 04
 * §4.8.4). Only verifyTombstoneAttestation constructs one, so a purged
 * tombstone that carries it has been checked.
 */
export interface VerifiedAttestation {
  readonly signerDeviceId: string
  readonly [verified]: true
}

/**
 * Why a purged tombstone is not attested (#2408):
 * - `unattested`: no attestation, or half of one (every marker shed before
 *   attestations existed, and every old client's delete);
 * - `signer_unknown`: no key for the named device, locally or on the server;
 * - `attestation_invalid`: the signature does not verify over this entry's
 *   own (type, id, clock, deletedAt), or is not a signature at all.
 */
export type AttestationRefusal = 'unattested' | 'signer_unknown' | 'attestation_invalid'

/** Verifies a purged tombstone's attestation under its signer's resolved key. */
export function verifyTombstoneAttestation(
  tombstone: DeleteClaim & { attestation?: TombstoneAttestation },
  signerKey: Uint8Array | null
): VerifiedAttestation | AttestationRefusal {
  const { attestation } = tombstone
  if (!attestation) return 'unattested'
  if (!signerKey) return 'signer_unknown'
  try {
    const signature = sodium.from_base64(attestation.signature, sodium.base64_variants.ORIGINAL)
    const valid = verifySignature(
      deleteAttestationPayload(tombstone),
      CBOR_FIELD_ORDER.DELETE_ATTESTATION,
      signature,
      signerKey
    )
    if (!valid) return 'attestation_invalid'
  } catch {
    // Malformed base64, a wrong-length signature or key: not a signature.
    return 'attestation_invalid'
  }
  return { signerDeviceId: attestation.signerDeviceId } as VerifiedAttestation
}
