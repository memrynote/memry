/**
 * Canonical CBOR Encoding
 *
 * Provides deterministic CBOR encoding (RFC 8949, Section 4.2) for use in
 * cryptographic signatures and HMACs. Canonical encoding ensures the same
 * data always produces identical bytes across platforms.
 *
 * @module main/crypto/cbor
 */

import { encode, decode, Token } from 'cborg'

/**
 * Map sorter for canonical CBOR encoding (RFC 8949, Section 4.2).
 * Sorts map keys by length first, then lexicographically.
 */
function canonicalMapSorter(e1: (Token | Token[])[], e2: (Token | Token[])[]): number {
  const t1 = e1[0] as Token
  const t2 = e2[0] as Token

  // Get the key values for comparison
  const k1 = t1.value as string | number | Uint8Array
  const k2 = t2.value as string | number | Uint8Array

  // Convert to comparable buffers
  const b1 = typeof k1 === 'string' ? Buffer.from(k1) : Buffer.from(String(k1))
  const b2 = typeof k2 === 'string' ? Buffer.from(k2) : Buffer.from(String(k2))

  // RFC 8949: Sort by length first, then lexicographically
  if (b1.length !== b2.length) {
    return b1.length - b2.length
  }

  return b1.compare(b2)
}

/**
 * Encode data to canonical CBOR bytes.
 *
 * Uses RFC 8949 Section 4.2 deterministic encoding:
 * - Map keys are sorted lexicographically by length, then value
 * - Integers use smallest possible encoding
 * - No indefinite-length items
 *
 * @param data - Data to encode
 * @returns Canonical CBOR bytes
 */
export function canonicalEncode(data: unknown): Uint8Array {
  return encode(data, {
    // Use float64 for all floating point numbers (consistency)
    float64: true,
    // Sort map keys for canonical encoding
    mapSorter: canonicalMapSorter
  })
}

/**
 * Decode CBOR bytes to data.
 *
 * @param bytes - CBOR bytes to decode
 * @returns Decoded data
 */
export function canonicalDecode<T = unknown>(bytes: Uint8Array): T {
  return decode(bytes) as T
}

/**
 * Create a signature payload for Ed25519 signing.
 *
 * This function constructs the canonical payload that will be signed,
 * ensuring all platforms produce identical bytes for the same data.
 *
 * @param payload - The SignaturePayloadV1 object to encode
 * @returns Canonical CBOR bytes ready for signing
 */
export function createSignaturePayload(payload: {
  id: string
  type: string
  operation?: string
  cryptoVersion: number
  encryptedKey: string
  keyNonce: string
  encryptedData: string
  dataNonce: string
  metadata?: {
    clock?: Record<string, number>
    fieldClocks?: Record<string, Record<string, number>>
    stateVector?: string
  }
}): Uint8Array {
  // Build the payload in a deterministic order
  const orderedPayload: Record<string, unknown> = {
    cryptoVersion: payload.cryptoVersion,
    dataNonce: payload.dataNonce,
    encryptedData: payload.encryptedData,
    encryptedKey: payload.encryptedKey,
    id: payload.id,
    keyNonce: payload.keyNonce,
    type: payload.type
  }

  // Add optional fields in alphabetical order
  if (payload.metadata !== undefined) {
    orderedPayload.metadata = payload.metadata
  }

  if (payload.operation !== undefined) {
    orderedPayload.operation = payload.operation
  }

  return canonicalEncode(orderedPayload)
}

/**
 * Create an HMAC payload for device linking.
 *
 * @param payload - The linking handshake data
 * @returns Canonical CBOR bytes for HMAC
 */
export function createLinkingHmacPayload(payload: {
  sessionId: string
  token?: string
  newDevicePublicKey?: string
  encryptedMasterKey?: string
  nonce?: string
}): Uint8Array {
  // Build payload in deterministic order (alphabetically)
  const orderedPayload: Record<string, string> = {}

  if (payload.encryptedMasterKey !== undefined) {
    orderedPayload.encryptedMasterKey = payload.encryptedMasterKey
  }

  if (payload.newDevicePublicKey !== undefined) {
    orderedPayload.newDevicePublicKey = payload.newDevicePublicKey
  }

  if (payload.nonce !== undefined) {
    orderedPayload.nonce = payload.nonce
  }

  orderedPayload.sessionId = payload.sessionId

  if (payload.token !== undefined) {
    orderedPayload.token = payload.token
  }

  return canonicalEncode(orderedPayload)
}
