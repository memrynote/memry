/**
 * Ed25519 Digital Signatures
 *
 * Implements Ed25519 signing and verification for data integrity.
 * All signatures are computed over canonical CBOR-encoded data to
 * ensure deterministic encoding across platforms.
 *
 * @module main/crypto/signatures
 */

import sodium from 'sodium-native'
import { canonicalEncode, createSignaturePayload } from './cbor'

// =============================================================================
// Constants
// =============================================================================

/** Ed25519 signature length (64 bytes) */
const SIGNATURE_LENGTH = sodium.crypto_sign_BYTES

/** Ed25519 public key length (32 bytes) */
const PUBLIC_KEY_LENGTH = sodium.crypto_sign_PUBLICKEYBYTES

/** Ed25519 secret key length (64 bytes) */
const SECRET_KEY_LENGTH = sodium.crypto_sign_SECRETKEYBYTES

// =============================================================================
// Basic Signing/Verification
// =============================================================================

/**
 * Sign data using Ed25519.
 *
 * The data is first encoded to canonical CBOR to ensure deterministic
 * encoding, then signed with the secret key.
 *
 * @param data - Data to sign (will be CBOR encoded)
 * @param secretKey - 64-byte Ed25519 secret key
 * @returns 64-byte signature
 */
export function sign(data: unknown, secretKey: Buffer): Buffer {
  if (secretKey.length !== SECRET_KEY_LENGTH) {
    throw new Error(`Secret key must be ${SECRET_KEY_LENGTH} bytes, got ${secretKey.length}`)
  }

  // Encode data to canonical CBOR
  const message = canonicalEncode(data)

  // Allocate signature buffer
  const signature = Buffer.alloc(SIGNATURE_LENGTH)

  // Sign the message
  sodium.crypto_sign_detached(signature, Buffer.from(message), secretKey)

  return signature
}

/**
 * Verify an Ed25519 signature.
 *
 * @param signature - 64-byte signature to verify
 * @param data - Original data (will be CBOR encoded)
 * @param publicKey - 32-byte Ed25519 public key
 * @returns true if signature is valid
 */
export function verify(signature: Buffer, data: unknown, publicKey: Buffer): boolean {
  if (signature.length !== SIGNATURE_LENGTH) {
    return false
  }

  if (publicKey.length !== PUBLIC_KEY_LENGTH) {
    return false
  }

  // Encode data to canonical CBOR
  const message = canonicalEncode(data)

  // Verify the signature
  return sodium.crypto_sign_verify_detached(signature, Buffer.from(message), publicKey)
}

// =============================================================================
// Raw Signing (Pre-encoded data)
// =============================================================================

/**
 * Sign raw bytes (already encoded).
 *
 * Use this when you've already prepared the canonical CBOR encoding.
 *
 * @param message - Pre-encoded message bytes
 * @param secretKey - 64-byte Ed25519 secret key
 * @returns 64-byte signature
 */
export function signRaw(message: Uint8Array | Buffer, secretKey: Buffer): Buffer {
  if (secretKey.length !== SECRET_KEY_LENGTH) {
    throw new Error(`Secret key must be ${SECRET_KEY_LENGTH} bytes, got ${secretKey.length}`)
  }

  const signature = Buffer.alloc(SIGNATURE_LENGTH)
  sodium.crypto_sign_detached(signature, Buffer.from(message), secretKey)

  return signature
}

/**
 * Verify signature on raw bytes.
 *
 * @param signature - 64-byte signature
 * @param message - Pre-encoded message bytes
 * @param publicKey - 32-byte Ed25519 public key
 * @returns true if signature is valid
 */
export function verifyRaw(
  signature: Buffer,
  message: Uint8Array | Buffer,
  publicKey: Buffer
): boolean {
  if (signature.length !== SIGNATURE_LENGTH || publicKey.length !== PUBLIC_KEY_LENGTH) {
    return false
  }

  return sodium.crypto_sign_verify_detached(signature, Buffer.from(message), publicKey)
}

// =============================================================================
// Encrypted Item Signing
// =============================================================================

/**
 * Sign an encrypted item.
 *
 * Creates a signature over all fields that influence decryption
 * and merge behavior, using canonical CBOR encoding.
 *
 * @param payload - Signature payload
 * @param secretKey - 64-byte Ed25519 secret key
 * @returns 64-byte signature
 */
export function signItem(
  payload: {
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
  },
  secretKey: Buffer
): Buffer {
  const message = createSignaturePayload(payload)
  return signRaw(message, secretKey)
}

/**
 * Verify an encrypted item signature.
 *
 * @param signature - 64-byte signature
 * @param payload - Signature payload
 * @param publicKey - 32-byte Ed25519 public key
 * @returns true if signature is valid
 */
export function verifyItem(
  signature: Buffer,
  payload: {
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
  },
  publicKey: Buffer
): boolean {
  const message = createSignaturePayload(payload)
  return verifyRaw(signature, message, publicKey)
}

// =============================================================================
// Base64 Helpers
// =============================================================================

/**
 * Sign data and return Base64-encoded signature.
 *
 * @param data - Data to sign
 * @param secretKey - Ed25519 secret key
 * @returns Base64-encoded signature
 */
export function signToBase64(data: unknown, secretKey: Buffer): string {
  const signature = sign(data, secretKey)
  return signature.toString('base64')
}

/**
 * Verify a Base64-encoded signature.
 *
 * @param signatureBase64 - Base64-encoded signature
 * @param data - Original data
 * @param publicKey - Ed25519 public key
 * @returns true if signature is valid
 */
export function verifyFromBase64(
  signatureBase64: string,
  data: unknown,
  publicKey: Buffer
): boolean {
  try {
    const signature = Buffer.from(signatureBase64, 'base64')
    return verify(signature, data, publicKey)
  } catch {
    return false
  }
}

// =============================================================================
// HMAC for Device Linking
// =============================================================================

/**
 * Compute HMAC-SHA256 for device linking handshakes.
 *
 * Used for proof-of-possession and key confirmation in the
 * QR code device linking protocol.
 *
 * @param key - 32-byte HMAC key
 * @param data - Data to authenticate (will be CBOR encoded)
 * @returns 32-byte HMAC
 */
export function computeHmac(key: Buffer, data: unknown): Buffer {
  if (key.length !== 32) {
    throw new Error(`HMAC key must be 32 bytes, got ${key.length}`)
  }

  const message = canonicalEncode(data)
  const hmac = Buffer.alloc(sodium.crypto_auth_BYTES)

  sodium.crypto_auth(hmac, Buffer.from(message), key)

  return hmac
}

/**
 * Verify HMAC-SHA256.
 *
 * @param hmac - 32-byte HMAC to verify
 * @param key - 32-byte HMAC key
 * @param data - Original data (will be CBOR encoded)
 * @returns true if HMAC is valid
 */
export function verifyHmac(hmac: Buffer, key: Buffer, data: unknown): boolean {
  if (hmac.length !== sodium.crypto_auth_BYTES || key.length !== 32) {
    return false
  }

  const message = canonicalEncode(data)

  return sodium.crypto_auth_verify(hmac, Buffer.from(message), key)
}

/**
 * Compute HMAC over raw bytes.
 *
 * @param key - 32-byte HMAC key
 * @param message - Raw message bytes
 * @returns 32-byte HMAC
 */
export function computeHmacRaw(key: Buffer, message: Uint8Array | Buffer): Buffer {
  const hmac = Buffer.alloc(sodium.crypto_auth_BYTES)
  sodium.crypto_auth(hmac, Buffer.from(message), key)
  return hmac
}

/**
 * Verify HMAC over raw bytes.
 *
 * @param hmac - 32-byte HMAC
 * @param key - 32-byte HMAC key
 * @param message - Raw message bytes
 * @returns true if valid
 */
export function verifyHmacRaw(hmac: Buffer, key: Buffer, message: Uint8Array | Buffer): boolean {
  if (hmac.length !== sodium.crypto_auth_BYTES || key.length !== 32) {
    return false
  }
  return sodium.crypto_auth_verify(hmac, Buffer.from(message), key)
}
