/**
 * AUTO-GENERATED - DO NOT EDIT DIRECTLY
 *
 * This file is automatically copied from src/shared/contracts/cbor-ordering.ts
 * Run `pnpm sync-contracts` to update.
 *
 * Changes should be made to the source file, not this copy.
 */

/**
 * CBOR Field Ordering Contract
 *
 * Defines the exact field order for deterministic CBOR encoding.
 * This ensures signatures are reproducible across devices.
 *
 * RFC 8949 Section 4.2.1 - Deterministic encoding requires:
 * 1. Map keys sorted by encoded length, then lexicographically
 * 2. We pre-define field order to ensure consistency
 */

/**
 * Field order for SignaturePayloadV1.
 * Fields are encoded in this exact order for deterministic signatures.
 */
export const SIGNATURE_PAYLOAD_V1_FIELD_ORDER = [
  'id',
  'type',
  'operation',
  'cryptoVersion',
  'encryptedKey',
  'keyNonce',
  'encryptedData',
  'dataNonce',
  'metadata'
] as const

/**
 * Field order for SignaturePayloadV1.metadata object.
 */
export const SIGNATURE_PAYLOAD_V1_METADATA_FIELD_ORDER = [
  'clock',
  'fieldClocks',
  'stateVector'
] as const

/**
 * Field order for EncryptedCrdtItem signature payload.
 */
export const CRDT_ITEM_PAYLOAD_FIELD_ORDER = [
  'id',
  'type',
  'cryptoVersion',
  'encryptedSnapshot',
  'snapshotNonce',
  'stateVector',
  'encryptedKey',
  'keyNonce'
] as const

/**
 * Field order for EncryptedUpdate signature payload.
 */
export const ENCRYPTED_UPDATE_PAYLOAD_FIELD_ORDER = [
  'noteId',
  'encryptedData',
  'nonce',
  'timestamp'
] as const

// =============================================================================
// T110a: Device Linking HMAC Proof Field Orders
// =============================================================================

/**
 * Field order for new device confirmation proof (SCAN_LINKING_QR).
 * The new device computes HMAC over this payload to prove possession of derived keys.
 *
 * Field order rationale:
 * - Order is chosen for semantic grouping (identifiers first, then data)
 * - RFC 8949 deterministic encoding is achieved by consistent application of
 *   this order on both client and server, not alphabetical sorting
 * - Both devices must use identical field ordering to produce matching HMACs
 */
export const LINKING_NEW_DEVICE_CONFIRM_FIELD_ORDER = [
  'sessionId',
  'token',
  'newDevicePublicKey'
] as const

/**
 * Field order for key confirmation proof (APPROVE_LINKING).
 * The existing device computes HMAC over this payload when transferring the master key.
 */
export const LINKING_KEY_CONFIRM_FIELD_ORDER = [
  'sessionId',
  'encryptedMasterKey',
  'encryptedKeyNonce'
] as const
