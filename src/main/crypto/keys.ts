/**
 * Key Derivation Module
 *
 * Implements HKDF, Argon2id master key derivation, and key generation.
 */

import sodium from 'sodium-native'
import { ensureSodiumReady } from './sodium'
import { CryptoError, CryptoErrorCode } from './errors'
import {
  HKDF_CONTEXTS,
  ARGON2_PARAMS,
  XCHACHA_PARAMS,
  ED25519_PARAMS
} from '@shared/contracts/crypto'
import type {
  DerivedKeys,
  DeviceSigningKeyPair,
  LinkingKeyPair,
  LinkingDerivedKeys
} from '@shared/contracts/crypto'
import * as cborg from 'cborg'

/**
 * Derive a key using HKDF with a context string.
 *
 * @param masterKey - 32-byte master key
 * @param context - Context string from HKDF_CONTEXTS
 * @param length - Output key length (default: 32)
 * @returns Derived key
 * @throws CryptoError if derivation fails
 */
export async function deriveKey(
  masterKey: Uint8Array,
  context: string,
  length: number = 32
): Promise<Uint8Array> {
  const sodium = await ensureSodiumReady()

  if (masterKey.length !== 32) {
    throw new CryptoError(
      `Invalid master key length: expected 32 bytes, got ${masterKey.length}`,
      CryptoErrorCode.INVALID_KEY_LENGTH
    )
  }

  try {
    // Use sodium's crypto_kdf_derive_from_key for HKDF-like derivation
    // Context must be exactly 8 characters (padded or truncated)
    const contextStr = context.slice(0, 8).padEnd(8, '\0')
    const subkeyId = contextToSubkeyId(context)

    return sodium.crypto_kdf_derive_from_key(length, subkeyId, contextStr, masterKey)
  } catch (error) {
    throw new CryptoError('Key derivation failed', CryptoErrorCode.KEY_DERIVATION_FAILED, error)
  }
}

/**
 * Map context string to a unique subkey ID.
 */
function contextToSubkeyId(context: string): number {
  switch (context) {
    case HKDF_CONTEXTS.VAULT_KEY:
      return 1
    case HKDF_CONTEXTS.SIGNING_KEY:
      return 2
    case HKDF_CONTEXTS.VERIFY_KEY:
      return 3
    case HKDF_CONTEXTS.LINKING_ENC:
      return 4
    case HKDF_CONTEXTS.LINKING_MAC:
      return 5
    case HKDF_CONTEXTS.KEY_VERIFY_INPUT:
      return 6
    default:
      // Hash the context for unknown contexts
      return Math.abs(hashCode(context)) % 1000000
  }
}

/**
 * Simple hash code for unknown context strings.
 */
function hashCode(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i)
    hash |= 0
  }
  return hash
}

/**
 * Derive master key from recovery phrase entropy using Argon2id.
 * Uses sodium-native for Argon2id which has full algorithm support.
 *
 * @param entropy - 32 bytes from recovery phrase
 * @param salt - 16-byte salt (from server)
 * @returns 32-byte master key
 * @throws CryptoError if derivation fails
 */
export function deriveMasterKey(entropy: Uint8Array, salt: Uint8Array): Uint8Array {
  if (entropy.length !== 32) {
    throw new CryptoError(
      `Invalid entropy length: expected 32 bytes, got ${entropy.length}`,
      CryptoErrorCode.INVALID_KEY_LENGTH
    )
  }

  if (salt.length !== 16) {
    throw new CryptoError(
      `Invalid salt length: expected 16 bytes, got ${salt.length}`,
      CryptoErrorCode.INVALID_KEY_LENGTH
    )
  }

  try {
    // Use sodium-native for Argon2id (full algorithm support)
    const output = Buffer.alloc(ARGON2_PARAMS.keyLength)
    const passwordBuffer = Buffer.from(entropy)
    const saltBuffer = Buffer.from(salt)

    sodium.crypto_pwhash(
      output,
      passwordBuffer,
      saltBuffer,
      ARGON2_PARAMS.timeCost,
      ARGON2_PARAMS.memoryCost * 1024, // Convert KiB to bytes
      sodium.crypto_pwhash_ALG_ARGON2ID13
    )

    return new Uint8Array(output)
  } catch (error) {
    throw new CryptoError(
      'Master key derivation failed',
      CryptoErrorCode.KEY_DERIVATION_FAILED,
      error
    )
  }
}

/**
 * Derive all sub-keys from master key.
 *
 * @param masterKey - 32-byte master key
 * @returns DerivedKeys object with vault key, signing keypair, and verify key
 * @throws CryptoError if derivation fails
 */
export async function deriveAllKeys(masterKey: Uint8Array): Promise<DerivedKeys> {
  const sodium = await ensureSodiumReady()

  // Derive vault key
  const vaultKey = await deriveKey(masterKey, HKDF_CONTEXTS.VAULT_KEY, XCHACHA_PARAMS.keySize)

  // Derive signing key seed and generate Ed25519 keypair
  const signingKeySeed = await deriveKey(
    masterKey,
    HKDF_CONTEXTS.SIGNING_KEY,
    ED25519_PARAMS.seedSize
  )
  const signingKeyPair = sodium.crypto_sign_seed_keypair(signingKeySeed) as {
    publicKey: Uint8Array
    privateKey: Uint8Array
  }

  // Derive verify key
  const verifyKey = await deriveKey(masterKey, HKDF_CONTEXTS.VERIFY_KEY, 32)

  return {
    vaultKey,
    signingKeyPair: {
      publicKey: signingKeyPair.publicKey,
      privateKey: signingKeyPair.privateKey
    },
    verifyKey
  }
}

/**
 * Generate a random file key for encrypting an item.
 *
 * @returns 32-byte random key
 */
export async function generateFileKey(): Promise<Uint8Array> {
  const sodium = await ensureSodiumReady()
  return sodium.randombytes_buf(XCHACHA_PARAMS.keySize)
}

/**
 * Generate a new Ed25519 device signing keypair.
 *
 * @param deviceId - The device ID to associate with this keypair
 * @returns DeviceSigningKeyPair
 */
export async function generateDeviceSigningKeyPair(
  deviceId: string
): Promise<DeviceSigningKeyPair> {
  const sodium = await ensureSodiumReady()
  const keyPair = sodium.crypto_sign_keypair() as {
    publicKey: Uint8Array
    privateKey: Uint8Array
  }

  return {
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey,
    deviceId
  }
}

/**
 * Get the public key from a device signing keypair.
 * Used for device registration with the server.
 *
 * @param keyPair - The device signing keypair
 * @returns Base64-encoded public key
 */
export function getDevicePublicKeyBase64(keyPair: DeviceSigningKeyPair): string {
  return uint8ArrayToBase64(keyPair.publicKey)
}

/**
 * Generate a random salt for Argon2id.
 *
 * @returns 16-byte random salt
 */
export async function generateSalt(): Promise<Uint8Array> {
  const sodium = await ensureSodiumReady()
  // crypto_pwhash_SALTBYTES is 16 bytes
  return sodium.randombytes_buf(16)
}

/**
 * Generate a random nonce for XChaCha20-Poly1305.
 *
 * @returns 24-byte random nonce
 */
export async function generateNonce(): Promise<Uint8Array> {
  const sodium = await ensureSodiumReady()
  return sodium.randombytes_buf(XCHACHA_PARAMS.nonceSize)
}

/**
 * Convert Uint8Array to Base64 string.
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  // Use Buffer in Node.js environment
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64')
  }
  // Fallback for browser
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

/**
 * Convert Base64 string to Uint8Array.
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  // Use Buffer in Node.js environment
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(base64, 'base64'))
  }
  // Fallback for browser
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

// =============================================================================
// T058: Key Verifier Generation
// =============================================================================

/**
 * Generate a key verifier from the master key.
 * Used for server-side verification without exposing the master key.
 *
 * The verifier is:
 * 1. Derive KEY_VERIFY_INPUT from master key using HKDF
 * 2. Hash the derived key with BLAKE2b to produce the verifier
 *
 * @param masterKey - 32-byte master key
 * @returns 32-byte key verifier
 * @throws CryptoError if generation fails
 */
export async function generateKeyVerifier(masterKey: Uint8Array): Promise<Uint8Array> {
  if (masterKey.length !== 32) {
    throw new CryptoError(
      `Invalid master key length: expected 32 bytes, got ${masterKey.length}`,
      CryptoErrorCode.INVALID_KEY_LENGTH
    )
  }

  try {
    const verifyInput = await deriveKey(masterKey, HKDF_CONTEXTS.KEY_VERIFY_INPUT, 32)
    // Use sodium-native's BLAKE2b hash (crypto_generichash)
    const hash = Buffer.alloc(32)
    sodium.crypto_generichash(hash, Buffer.from(verifyInput))
    return new Uint8Array(hash)
  } catch (error) {
    throw new CryptoError(
      'Key verifier generation failed',
      CryptoErrorCode.KEY_DERIVATION_FAILED,
      error
    )
  }
}

// =============================================================================
// T059: Vault Key Derivation
// =============================================================================

/**
 * Derive the vault key from master key.
 * Used for encrypting/decrypting file keys.
 *
 * @param masterKey - 32-byte master key
 * @returns 32-byte vault key
 * @throws CryptoError if derivation fails
 */
export async function deriveVaultKey(masterKey: Uint8Array): Promise<Uint8Array> {
  return deriveKey(masterKey, HKDF_CONTEXTS.VAULT_KEY, XCHACHA_PARAMS.keySize)
}

// =============================================================================
// T060: Signing Keypair Derivation
// =============================================================================

/**
 * Derive Ed25519 signing keypair from master key.
 * This is the user-level signing keypair (different from device keypair).
 *
 * @param masterKey - 32-byte master key
 * @returns Ed25519 keypair with publicKey and privateKey
 * @throws CryptoError if derivation fails
 */
export async function deriveSigningKeyPair(
  masterKey: Uint8Array
): Promise<{ publicKey: Uint8Array; privateKey: Uint8Array }> {
  const sodium = await ensureSodiumReady()

  if (masterKey.length !== 32) {
    throw new CryptoError(
      `Invalid master key length: expected 32 bytes, got ${masterKey.length}`,
      CryptoErrorCode.INVALID_KEY_LENGTH
    )
  }

  try {
    const signingKeySeed = await deriveKey(
      masterKey,
      HKDF_CONTEXTS.SIGNING_KEY,
      ED25519_PARAMS.seedSize
    )
    const keyPair = sodium.crypto_sign_seed_keypair(signingKeySeed) as {
      publicKey: Uint8Array
      privateKey: Uint8Array
    }
    return keyPair
  } catch (error) {
    throw new CryptoError(
      'Signing keypair derivation failed',
      CryptoErrorCode.KEY_DERIVATION_FAILED,
      error
    )
  }
}

// =============================================================================
// T060: Verify Key Derivation
// =============================================================================

/**
 * Derive the verify key from master key.
 * Used for key verification processes.
 *
 * @param masterKey - 32-byte master key
 * @returns 32-byte verify key
 * @throws CryptoError if derivation fails
 */
export async function deriveVerifyKey(masterKey: Uint8Array): Promise<Uint8Array> {
  return deriveKey(masterKey, HKDF_CONTEXTS.VERIFY_KEY, 32)
}

/**
 * Compare two byte arrays in constant time.
 * Used for secure comparison of key verifiers and other secrets.
 *
 * @param a - First byte array
 * @param b - Second byte array
 * @returns true if arrays are equal
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false
  }
  // Use sodium-native's constant-time comparison
  return sodium.sodium_memcmp(Buffer.from(a), Buffer.from(b))
}

// =============================================================================
// T109: X25519 Keypair Generation for Device Linking
// =============================================================================

/**
 * Generate an ephemeral X25519 keypair for device linking ECDH.
 *
 * These keys are used for the key exchange during device linking:
 * - Public key is shared via QR code or server
 * - Private key is held in memory only (never persisted)
 * - Both devices generate keypairs and perform ECDH to derive shared secrets
 *
 * @returns LinkingKeyPair with Base64-encoded public and private keys
 * @throws CryptoError if key generation fails
 */
export function generateLinkingKeyPair(): LinkingKeyPair {
  try {
    const publicKey = Buffer.alloc(sodium.crypto_kx_PUBLICKEYBYTES)
    const privateKey = Buffer.alloc(sodium.crypto_kx_SECRETKEYBYTES)

    sodium.crypto_kx_keypair(publicKey, privateKey)

    return {
      publicKey: uint8ArrayToBase64(new Uint8Array(publicKey)),
      privateKey: uint8ArrayToBase64(new Uint8Array(privateKey))
    }
  } catch (error) {
    throw new CryptoError(
      'Failed to generate linking keypair',
      CryptoErrorCode.KEY_GENERATION_FAILED,
      error
    )
  }
}

// =============================================================================
// T110: ECDH Shared Secret + HKDF Key Derivation for Device Linking
// =============================================================================

/**
 * Derive encryption and MAC keys for device linking from ECDH shared secret.
 *
 * Performs X25519 ECDH between the local private key and remote public key,
 * then derives two separate keys using HKDF:
 * - encryptionKey: For encrypting the master key during transfer
 * - macKey: For computing HMAC proofs to verify the handshake
 *
 * Security assumptions:
 * - myPrivateKey is a valid 32-byte X25519 private key
 * - theirPublicKey is a valid 32-byte X25519 public key from the other device
 * - The ECDH shared secret has sufficient entropy for key derivation
 *
 * @param myPrivateKey - Local X25519 private key (32 bytes)
 * @param theirPublicKey - Remote X25519 public key (32 bytes)
 * @returns LinkingDerivedKeys with encryption and MAC keys
 * @throws CryptoError if key sizes are invalid or derivation fails
 */
export async function deriveLinkingKeys(
  myPrivateKey: Uint8Array,
  theirPublicKey: Uint8Array
): Promise<LinkingDerivedKeys> {
  if (myPrivateKey.length !== 32) {
    throw new CryptoError(
      `Invalid private key length: expected 32 bytes, got ${myPrivateKey.length}`,
      CryptoErrorCode.INVALID_KEY_LENGTH
    )
  }

  if (theirPublicKey.length !== 32) {
    throw new CryptoError(
      `Invalid public key length: expected 32 bytes, got ${theirPublicKey.length}`,
      CryptoErrorCode.INVALID_KEY_LENGTH
    )
  }

  try {
    // Step 1: Compute ECDH shared secret using X25519 scalar multiplication
    const sharedSecret = Buffer.alloc(sodium.crypto_scalarmult_BYTES)
    sodium.crypto_scalarmult(
      sharedSecret,
      Buffer.from(myPrivateKey),
      Buffer.from(theirPublicKey)
    )

    // Step 2: Derive encryption key using HKDF (via crypto_kdf)
    const encryptionKey = await deriveKey(
      new Uint8Array(sharedSecret),
      HKDF_CONTEXTS.LINKING_ENC,
      32
    )

    // Step 3: Derive MAC key using HKDF (via crypto_kdf)
    const macKey = await deriveKey(
      new Uint8Array(sharedSecret),
      HKDF_CONTEXTS.LINKING_MAC,
      32
    )

    // Step 4: Zero the shared secret from memory
    sodium.sodium_memzero(sharedSecret)

    return {
      encryptionKey,
      macKey
    }
  } catch (error) {
    if (error instanceof CryptoError) {
      throw error
    }
    throw new CryptoError(
      'Failed to derive linking keys',
      CryptoErrorCode.KEY_DERIVATION_FAILED,
      error
    )
  }
}

// =============================================================================
// T110a: Linking HMAC Proofs
// =============================================================================

/**
 * Compute an HMAC proof for device linking verification.
 *
 * Creates a keyed hash (BLAKE2b-256) over the canonical CBOR encoding of the payload.
 * The field order ensures deterministic encoding across devices.
 *
 * Used for:
 * - newDeviceConfirm: New device proves it derived keys from QR code
 * - keyConfirm: Existing device proves the encrypted master key is authentic
 *
 * Security assumptions:
 * - macKey is a 32-byte key derived from ECDH shared secret
 * - fieldOrder matches the expected order on the verifying device
 * - Payload values are the exact values being confirmed
 *
 * @param macKey - 32-byte MAC key from deriveLinkingKeys()
 * @param payload - Object containing fields to include in the proof
 * @param fieldOrder - Array specifying the canonical field order
 * @returns 32-byte HMAC proof
 * @throws CryptoError if MAC key is invalid or computation fails
 */
export function computeLinkingProof(
  macKey: Uint8Array,
  payload: Record<string, unknown>,
  fieldOrder: readonly string[]
): Uint8Array {
  if (macKey.length !== 32) {
    throw new CryptoError(
      `Invalid MAC key length: expected 32 bytes, got ${macKey.length}`,
      CryptoErrorCode.INVALID_KEY_LENGTH
    )
  }

  try {
    // Step 1: Order fields according to the specified order (only include present fields)
    const orderedPayload: Record<string, unknown> = {}
    for (const field of fieldOrder) {
      if (field in payload && payload[field] !== undefined) {
        orderedPayload[field] = payload[field]
      }
    }

    // Step 2: Encode to canonical CBOR
    const cborData = cborg.encode(orderedPayload, { float64: true })

    // Step 3: Compute keyed BLAKE2b-256 hash (HMAC-like construction)
    const proof = Buffer.alloc(32)
    sodium.crypto_generichash(
      proof,
      Buffer.from(cborData),
      Buffer.from(macKey)
    )

    return new Uint8Array(proof)
  } catch (error) {
    if (error instanceof CryptoError) {
      throw error
    }
    throw new CryptoError(
      'Failed to compute linking proof',
      CryptoErrorCode.HMAC_FAILED,
      error
    )
  }
}

/**
 * Verify a linking HMAC proof.
 *
 * Recomputes the proof from the payload and compares in constant time.
 *
 * @param macKey - 32-byte MAC key
 * @param payload - The payload that was supposedly signed
 * @param fieldOrder - The canonical field order
 * @param proof - The proof to verify
 * @returns true if the proof is valid
 */
export function verifyLinkingProof(
  macKey: Uint8Array,
  payload: Record<string, unknown>,
  fieldOrder: readonly string[],
  proof: Uint8Array
): boolean {
  if (proof.length !== 32) {
    return false
  }

  try {
    const expectedProof = computeLinkingProof(macKey, payload, fieldOrder)
    return constantTimeEqual(expectedProof, proof)
  } catch {
    return false
  }
}
