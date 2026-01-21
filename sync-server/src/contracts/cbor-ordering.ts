/**
 * CBOR Field Ordering Contract
 *
 * Defines the exact field order for deterministic CBOR encoding.
 * This ensures signatures are reproducible across devices.
 *
 * RFC 8949 Section 4.2.1 - Deterministic encoding requires:
 * 1. Map keys sorted by encoded length, then lexicographically
 * 2. We pre-define field order to ensure consistency
 *
 * NOTE: This file is a copy of src/shared/contracts/cbor-ordering.ts
 * Keep in sync with the client-side contract.
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
  'metadata',
] as const

/**
 * Field order for SignaturePayloadV1.metadata object.
 */
export const SIGNATURE_PAYLOAD_V1_METADATA_FIELD_ORDER = [
  'clock',
  'fieldClocks',
  'stateVector',
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
  'keyNonce',
] as const

/**
 * Field order for EncryptedUpdate signature payload.
 */
export const ENCRYPTED_UPDATE_PAYLOAD_FIELD_ORDER = [
  'noteId',
  'encryptedData',
  'nonce',
  'timestamp',
] as const
