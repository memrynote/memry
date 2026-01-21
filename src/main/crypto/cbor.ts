/**
 * Canonical CBOR Encoding
 *
 * Implements deterministic CBOR encoding for signature payloads.
 * Uses RFC 8949 Section 4.2.1 deterministic encoding rules.
 */

import * as cborg from 'cborg'
import { CryptoError, CryptoErrorCode } from './errors'
import {
  SIGNATURE_PAYLOAD_V1_FIELD_ORDER,
  SIGNATURE_PAYLOAD_V1_METADATA_FIELD_ORDER,
  CRDT_ITEM_PAYLOAD_FIELD_ORDER,
  ENCRYPTED_UPDATE_PAYLOAD_FIELD_ORDER
} from '@shared/contracts/cbor-ordering'
import type { SignaturePayloadV1 } from '@shared/contracts/crypto'

/**
 * Order object fields according to a predefined order.
 * Fields not in the order array are omitted.
 */
function orderFields<T extends Record<string, unknown>>(
  obj: T,
  fieldOrder: readonly string[]
): Record<string, unknown> {
  const ordered: Record<string, unknown> = {}

  for (const key of fieldOrder) {
    if (key in obj && obj[key] !== undefined) {
      ordered[key] = obj[key]
    }
  }

  return ordered
}

/**
 * Prepare a SignaturePayloadV1 for canonical encoding.
 * Ensures fields are in the correct order and metadata is properly ordered.
 */
function prepareSignaturePayloadV1(payload: SignaturePayloadV1): Record<string, unknown> {
  const prepared = orderFields(
    payload as unknown as Record<string, unknown>,
    SIGNATURE_PAYLOAD_V1_FIELD_ORDER
  )

  // Order metadata fields if present
  if (payload.metadata) {
    prepared.metadata = orderFields(payload.metadata, SIGNATURE_PAYLOAD_V1_METADATA_FIELD_ORDER)
  }

  return prepared
}

/**
 * Encode a SignaturePayloadV1 to canonical CBOR bytes.
 *
 * @param payload - The signature payload to encode
 * @returns Canonical CBOR bytes
 * @throws CryptoError if encoding fails
 */
export function encodeSignaturePayloadV1(payload: SignaturePayloadV1): Uint8Array {
  try {
    const prepared = prepareSignaturePayloadV1(payload)
    return cborg.encode(prepared, {
      // Use canonical/deterministic encoding
      float64: true, // Consistent float representation
      typeEncoders: {} // No custom type encoders
    })
  } catch (error) {
    throw new CryptoError(
      'Failed to encode signature payload',
      CryptoErrorCode.ENCODING_FAILED,
      error
    )
  }
}

/**
 * Encode data to canonical CBOR bytes.
 * Uses predefined field ordering for known types.
 *
 * @param data - The data to encode
 * @param type - Optional type hint for field ordering
 * @returns Canonical CBOR bytes
 * @throws CryptoError if encoding fails
 */
export function encodeCanonicalCbor(
  data: unknown,
  type?: 'signature-payload-v1' | 'crdt-item' | 'encrypted-update'
): Uint8Array {
  try {
    let prepared: unknown = data

    // Apply field ordering based on type
    if (type === 'signature-payload-v1' && typeof data === 'object' && data !== null) {
      prepared = prepareSignaturePayloadV1(data as SignaturePayloadV1)
    } else if (type === 'crdt-item' && typeof data === 'object' && data !== null) {
      prepared = orderFields(data as Record<string, unknown>, CRDT_ITEM_PAYLOAD_FIELD_ORDER)
    } else if (type === 'encrypted-update' && typeof data === 'object' && data !== null) {
      prepared = orderFields(data as Record<string, unknown>, ENCRYPTED_UPDATE_PAYLOAD_FIELD_ORDER)
    }

    return cborg.encode(prepared, {
      float64: true
    })
  } catch (error) {
    throw new CryptoError('Failed to encode CBOR', CryptoErrorCode.ENCODING_FAILED, error)
  }
}

/**
 * Decode CBOR bytes to data.
 *
 * @param data - The CBOR bytes to decode
 * @returns Decoded data
 * @throws CryptoError if decoding fails
 */
export function decodeCbor<T = unknown>(data: Uint8Array): T {
  try {
    return cborg.decode(data) as T
  } catch (error) {
    throw new CryptoError('Failed to decode CBOR', CryptoErrorCode.ENCODING_FAILED, error)
  }
}
