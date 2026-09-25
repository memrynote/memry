import {
  RECORD_CLOCK_REQUIRED_ITEM_TYPES,
  type RecordClockRequiredItemType,
  type VectorClock
} from './sync-api'

/**
 * Delete attestations (#2408, protocol 04 §4.8.4). The deleting device signs
 * a content-free claim `(purpose, id, type, deletedAt, clock)` with its
 * Ed25519 device key, encoded as canonical CBOR under
 * `CBOR_FIELD_ORDER.DELETE_ATTESTATION`. The server keeps the signature when
 * it sheds the tombstone's payload, so a purged tombstone stays verifiable.
 */
export const DELETE_ATTESTATION_PURPOSE = 'memry-delete-attestation-v1' as const

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
    type: item.type as RecordClockRequiredItemType,
    deletedAt: item.deletedAt,
    clock: item.clock
  }
}

/** The map to encode under `CBOR_FIELD_ORDER.DELETE_ATTESTATION`. */
export function deleteAttestationPayload(claim: DeleteClaim): Record<string, unknown> {
  return {
    purpose: DELETE_ATTESTATION_PURPOSE,
    id: claim.id,
    type: claim.type,
    deletedAt: claim.deletedAt,
    clock: claim.clock
  }
}
