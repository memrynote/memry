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
import type { DerivedKeys, DeviceSigningKeyPair } from '@shared/contracts/crypto'

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

    return sodium.crypto_kdf_derive_from_key(
      length,
      subkeyId,
      contextStr,
      masterKey
    ) as Uint8Array
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
export async function deriveMasterKey(entropy: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
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
  return sodium.randombytes_buf(XCHACHA_PARAMS.keySize) as Uint8Array
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
  return sodium.randombytes_buf(16) as Uint8Array
}

/**
 * Generate a random nonce for XChaCha20-Poly1305.
 *
 * @returns 24-byte random nonce
 */
export async function generateNonce(): Promise<Uint8Array> {
  const sodium = await ensureSodiumReady()
  return sodium.randombytes_buf(XCHACHA_PARAMS.nonceSize) as Uint8Array
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
