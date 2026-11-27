import {
  RECORD_CLOCK_REQUIRED_ITEM_TYPES,
  type RecordClockRequiredItemType,
  type VectorClock
} from './sync-api'

/**
 * Delete attestations (#2408, protocol 04 §4.8.4). The deleting device signs
 * a content-free claim `(purpose, vaultId, id, type, deletedAt, clock)` with
 * its Ed25519 device key, encoded as canonical CBOR under
 * `CBOR_FIELD_ORDER.DELETE_ATTESTATION`. The server keeps the signature when
 * it sheds the tombstone's payload, so a purged tombstone stays verifiable.
 *
 * v2 (#5247) binds the vault id, so the server cannot replay a delete signed
 * in one vault into another vault of the account.
 */
export const DELETE_ATTESTATION_PURPOSE = 'memry-delete-attestation-v2' as const

/**
 * Compatibility contract: devices built before #5247 sign this purpose, with
 * no vault id, and the server still holds their attestations. Verifiers keep
 * accepting it.
 */
export const DELETE_ATTESTATION_PURPOSE_V1 = 'memry-delete-attestation-v1' as const

/** The facts a delete attestation signs, exactly as pushed and stored. */
export interface DeleteClaim {
  id: string
  type: RecordClockRequiredItemType
  deletedAt: number
  clock: VectorClock
}

const CLOCK_REQUIRED_TYPES = new Set<string>(RECORD_CLOCK_REQUIRED_ITEM_TYPES)

/**
 * The single "is this write attestable" rule, shared by every signer and the
 * server: a delete of a clock-required type with a non-empty clock and a
 * `deletedAt`. The server stores `deletedAt ?? now`, so without a pushed
 * `deletedAt` the served value cannot be signed in advance.
 */
export function deleteClaimOf(item: {
  id: string
  type: string
  operation: string
  clock?: VectorClock
  deletedAt?: number
}): DeleteClaim | null {
  if (item.operation !== 'delete' || !CLOCK_REQUIRED_TYPES.has(item.type)) return null
  if (!item.clock || Object.keys(item.clock).length === 0) return null
  if (item.deletedAt === undefined || !Number.isSafeInteger(item.deletedAt) || item.deletedAt < 0) {
    return null
  }
  return {
    id: item.id,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- item.type was checked against the record-clock item types above
    type: item.type as RecordClockRequiredItemType,
    deletedAt: item.deletedAt,
    clock: item.clock
  }
}

/**
 * The map a device signs under `CBOR_FIELD_ORDER.DELETE_ATTESTATION`: v2
 * bound to `vaultId`, the vault the push is routed to (`X-Memry-Vault-Id`).
 * `null` is a device that sends no vault id; it signs v1, which the server
 * accepts from any vault.
 */
export function deleteAttestationPayload(
  claim: DeleteClaim,
  vaultId: string | null
): Record<string, unknown> {
  const fields = { id: claim.id, type: claim.type, deletedAt: claim.deletedAt, clock: claim.clock }
  return vaultId === null
    ? { purpose: DELETE_ATTESTATION_PURPOSE_V1, ...fields }
    : { purpose: DELETE_ATTESTATION_PURPOSE, vaultId, ...fields }
}

/**
 * Every payload a verifier in `vaultId` accepts for `claim`: v2 bound to this
 * vault, then v1 (#5247 compatibility, see DELETE_ATTESTATION_PURPOSE_V1).
 */
export function acceptedDeleteAttestationPayloads(
  claim: DeleteClaim,
  vaultId: string | null
): Array<Record<string, unknown>> {
  const v1 = deleteAttestationPayload(claim, null)
  return vaultId === null ? [v1] : [deleteAttestationPayload(claim, vaultId), v1]
}
