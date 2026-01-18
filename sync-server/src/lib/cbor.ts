/**
 * Canonical CBOR Encoding (Server-side)
 *
 * Provides deterministic CBOR encoding (RFC 8949, Section 4.2) for use in
 * cryptographic signatures and HMACs. This is the server-side equivalent
 * of the client's CBOR module.
 *
 * @module lib/cbor
 */

import { encode, decode } from 'cborg'

/**
 * Encode data to canonical CBOR bytes.
 *
 * Uses RFC 8949 Section 4.2 deterministic encoding:
 * - Map keys are sorted lexicographically
 * - Integers use smallest possible encoding
 * - No indefinite-length items
 *
 * @param data - Data to encode
 * @returns Canonical CBOR bytes
 */
export function canonicalEncode(data: unknown): Uint8Array {
  return encode(data, {
    canonical: true,
    float64: true
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
 * Encode object and return as Base64.
 *
 * @param data - Data to encode
 * @returns Base64-encoded CBOR
 */
export function encodeToBase64(data: unknown): string {
  const bytes = canonicalEncode(data)
  return btoa(String.fromCharCode(...bytes))
}

/**
 * Decode Base64 CBOR data.
 *
 * @param base64 - Base64-encoded CBOR
 * @returns Decoded data
 */
export function decodeFromBase64<T = unknown>(base64: string): T {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return canonicalDecode<T>(bytes)
}
