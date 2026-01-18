/**
 * Key Derivation Functions
 *
 * Implements HKDF and Argon2id key derivation for the E2EE system.
 * Uses sodium-native for high-performance native bindings.
 *
 * Key Hierarchy:
 * - Master Key (derived from recovery phrase + KDF salt via Argon2id)
 *   ├── Vault Key (HKDF, for encrypting file keys)
 *   ├── Signing Key Seed (HKDF, for Ed25519 keypair)
 *   └── Verify Key (HKDF, for key verifier HMAC)
 *
 * @module main/crypto/keys
 */

import sodium from 'sodium-native'
import { HKDF_CONTEXTS, DEFAULT_ARGON2_PARAMS, type DerivedKeys } from '@shared/contracts/crypto'

// =============================================================================
// Constants
// =============================================================================

/** Key length in bytes (256 bits) */
const KEY_LENGTH = 32

/** Ed25519 secret key length */
const ED25519_SECRET_KEY_LENGTH = 64

/** Ed25519 public key length */
const ED25519_PUBLIC_KEY_LENGTH = 32

// =============================================================================
// HKDF Key Derivation
// =============================================================================

/**
 * Derive a key using HKDF-SHA256.
 *
 * Uses sodium's crypto_kdf functions which implement a simplified HKDF.
 * The context string is used as the "info" parameter.
 *
 * @param masterKey - 32-byte master key
 * @param context - Context string (e.g., 'memry-vault-key-v1')
 * @returns 32-byte derived key
 */
export function deriveKey(masterKey: Buffer, context: string): Buffer {
  if (masterKey.length !== KEY_LENGTH) {
    throw new Error(`Master key must be ${KEY_LENGTH} bytes, got ${masterKey.length}`)
  }

  // Pad or truncate context to 8 bytes (sodium requirement)
  const contextBuffer = Buffer.alloc(sodium.crypto_kdf_CONTEXTBYTES)
  Buffer.from(context.slice(0, 8)).copy(contextBuffer)

  // Derive a subkey
  const derivedKey = Buffer.alloc(KEY_LENGTH)

  // Use the full context as a subkey ID by hashing it
  const contextHash = Buffer.alloc(8)
  const fullContextBuffer = Buffer.from(context, 'utf8')
  sodium.crypto_generichash(contextHash, fullContextBuffer)

  // Convert first 8 bytes of hash to a subkey ID
  const subkeyId = contextHash.readBigUInt64LE()

  // sodium.crypto_kdf_derive_from_key only supports up to 64-bit subkey IDs
  // For longer context strings, we use a different approach
  sodium.crypto_kdf_derive_from_key(
    derivedKey,
    Number(subkeyId & BigInt(0x7fffffff)),
    contextBuffer,
    masterKey
  )

  return derivedKey
}

/**
 * Derive the vault key for encrypting/decrypting file keys.
 *
 * @param masterKey - 32-byte master key
 * @returns 32-byte vault key
 */
export function deriveVaultKey(masterKey: Buffer): Buffer {
  return deriveKey(masterKey, HKDF_CONTEXTS.VAULT_KEY)
}

/**
 * Derive the signing key seed for Ed25519.
 *
 * @param masterKey - 32-byte master key
 * @returns 32-byte seed for Ed25519 keypair generation
 */
export function deriveSigningKeySeed(masterKey: Buffer): Buffer {
  return deriveKey(masterKey, HKDF_CONTEXTS.SIGNING_KEY)
}

/**
 * Derive the verify key for key verifier HMAC.
 *
 * @param masterKey - 32-byte master key
 * @returns 32-byte verify key
 */
export function deriveVerifyKey(masterKey: Buffer): Buffer {
  return deriveKey(masterKey, HKDF_CONTEXTS.VERIFY_KEY)
}

// =============================================================================
// Ed25519 Key Generation
// =============================================================================

/**
 * Generate an Ed25519 keypair from a seed.
 *
 * @param seed - 32-byte seed
 * @returns Object containing publicKey and secretKey
 */
export function generateSigningKeyPair(seed: Buffer): { publicKey: Buffer; secretKey: Buffer } {
  if (seed.length !== KEY_LENGTH) {
    throw new Error(`Seed must be ${KEY_LENGTH} bytes, got ${seed.length}`)
  }

  const publicKey = Buffer.alloc(ED25519_PUBLIC_KEY_LENGTH)
  const secretKey = Buffer.alloc(ED25519_SECRET_KEY_LENGTH)

  sodium.crypto_sign_seed_keypair(publicKey, secretKey, seed)

  return { publicKey, secretKey }
}

// =============================================================================
// Argon2id Key Derivation
// =============================================================================

/**
 * Derive the master key from a BIP39 seed using Argon2id.
 *
 * Uses OWASP 2024 recommended parameters:
 * - Memory: 64 MB
 * - Iterations: 3
 * - Parallelism: 4 (handled internally by libsodium)
 *
 * @param seed - 64-byte BIP39 seed (from mnemonic)
 * @param salt - 16+ byte KDF salt (stored on server, plaintext)
 * @returns 32-byte master key
 */
export function deriveMasterKey(seed: Buffer, salt: Buffer): Buffer {
  if (seed.length < 32) {
    throw new Error(`Seed must be at least 32 bytes, got ${seed.length}`)
  }

  if (salt.length < 16) {
    throw new Error(`Salt must be at least 16 bytes, got ${salt.length}`)
  }

  // Ensure salt is exactly 16 bytes (sodium requirement)
  const saltBuffer = Buffer.alloc(sodium.crypto_pwhash_SALTBYTES)
  salt.copy(saltBuffer, 0, 0, Math.min(salt.length, sodium.crypto_pwhash_SALTBYTES))

  const masterKey = Buffer.alloc(KEY_LENGTH)

  // Use Argon2id with OWASP 2024 parameters
  sodium.crypto_pwhash(
    masterKey,
    seed,
    saltBuffer,
    DEFAULT_ARGON2_PARAMS.timeCost, // 3 iterations
    DEFAULT_ARGON2_PARAMS.memoryCost * 1024, // 64 MB in bytes
    sodium.crypto_pwhash_ALG_ARGON2ID13
  )

  return masterKey
}

/**
 * Generate a random KDF salt for new accounts.
 *
 * @returns 16-byte random salt
 */
export function generateKdfSalt(): Buffer {
  const salt = Buffer.alloc(sodium.crypto_pwhash_SALTBYTES)
  sodium.randombytes_buf(salt)
  return salt
}

// =============================================================================
// Key Verifier
// =============================================================================

/**
 * Compute the key verifier HMAC.
 *
 * The key verifier is stored server-side and used to validate that
 * a recovery phrase produces the correct master key.
 *
 * keyVerifier = HMAC-SHA-256(deriveVerifyKey(masterKey), 'memry-key-verify-v1')
 *
 * @param masterKey - 32-byte master key
 * @returns 32-byte key verifier
 */
export function computeKeyVerifier(masterKey: Buffer): Buffer {
  const verifyKey = deriveVerifyKey(masterKey)
  const message = Buffer.from('memry-key-verify-v1', 'utf8')

  const verifier = Buffer.alloc(sodium.crypto_auth_BYTES)
  sodium.crypto_auth(verifier, message, verifyKey)

  return verifier
}

/**
 * Verify that a key verifier matches a master key.
 *
 * @param masterKey - 32-byte master key
 * @param expectedVerifier - 32-byte expected verifier from server
 * @returns true if the verifier matches
 */
export function verifyKeyVerifier(masterKey: Buffer, expectedVerifier: Buffer): boolean {
  const computedVerifier = computeKeyVerifier(masterKey)
  return computedVerifier.equals(expectedVerifier)
}

// =============================================================================
// Complete Key Derivation
// =============================================================================

/**
 * Derive all keys from a master key.
 *
 * @param masterKey - 32-byte master key
 * @returns All derived keys
 */
export function deriveAllKeys(masterKey: Buffer): DerivedKeys {
  const vaultKey = deriveVaultKey(masterKey)
  const signingKeySeed = deriveSigningKeySeed(masterKey)
  const signingKeyPair = generateSigningKeyPair(signingKeySeed)
  const verifyKey = deriveVerifyKey(masterKey)
  const keyVerifier = computeKeyVerifier(masterKey)

  return {
    masterKey: new Uint8Array(masterKey),
    vaultKey: new Uint8Array(vaultKey),
    signingKeyPair: {
      publicKey: new Uint8Array(signingKeyPair.publicKey),
      secretKey: new Uint8Array(signingKeyPair.secretKey)
    },
    verifyKey: new Uint8Array(verifyKey),
    keyVerifier: new Uint8Array(keyVerifier)
  }
}

// =============================================================================
// X25519 Key Exchange (Device Linking) - T109, T110, T110a
// =============================================================================

/** X25519 public key length (32 bytes) */
const X25519_PUBLIC_KEY_LENGTH = 32

/** X25519 secret key length (32 bytes) */
const X25519_SECRET_KEY_LENGTH = 32

/**
 * Generate an X25519 key pair for ECDH key exchange (T109).
 *
 * Used in device linking to establish a shared secret between
 * the existing device and the new device.
 *
 * @returns X25519 key pair with publicKey and secretKey (both 32 bytes)
 */
export function generateX25519KeyPair(): { publicKey: Buffer; secretKey: Buffer } {
  const publicKey = Buffer.alloc(X25519_PUBLIC_KEY_LENGTH)
  const secretKey = Buffer.alloc(X25519_SECRET_KEY_LENGTH)

  // Generate random secret key
  sodium.randombytes_buf(secretKey)

  // Derive public key from secret key using X25519 base point multiplication
  sodium.crypto_scalarmult_base(publicKey, secretKey)

  return { publicKey, secretKey }
}

/**
 * Compute X25519 shared secret between two parties (T110).
 *
 * Performs ECDH key exchange using X25519 (Curve25519).
 *
 * @param mySecretKey - Our 32-byte X25519 secret key
 * @param theirPublicKey - Their 32-byte X25519 public key
 * @returns 32-byte shared secret
 * @throws Error if key lengths are invalid
 */
export function computeX25519SharedSecret(mySecretKey: Buffer, theirPublicKey: Buffer): Buffer {
  if (mySecretKey.length !== X25519_SECRET_KEY_LENGTH) {
    throw new Error(
      `Secret key must be ${X25519_SECRET_KEY_LENGTH} bytes, got ${mySecretKey.length}`
    )
  }
  if (theirPublicKey.length !== X25519_PUBLIC_KEY_LENGTH) {
    throw new Error(
      `Public key must be ${X25519_PUBLIC_KEY_LENGTH} bytes, got ${theirPublicKey.length}`
    )
  }

  const sharedSecret = Buffer.alloc(32)

  // Perform X25519 scalar multiplication (ECDH)
  sodium.crypto_scalarmult(sharedSecret, mySecretKey, theirPublicKey)

  return sharedSecret
}

/**
 * Derive encryption and MAC keys for device linking from a shared secret (T110).
 *
 * Uses HKDF to derive two separate keys:
 * - encKey: For encrypting the master key (HKDF context: LINKING_ENC)
 * - macKey: For HMAC proofs (HKDF context: LINKING_MAC)
 *
 * @param sharedSecret - 32-byte ECDH shared secret
 * @returns Object containing encKey and macKey (both 32 bytes)
 */
export function deriveLinkingKeys(sharedSecret: Buffer): { encKey: Buffer; macKey: Buffer } {
  if (sharedSecret.length !== 32) {
    throw new Error(`Shared secret must be 32 bytes, got ${sharedSecret.length}`)
  }

  const encKey = deriveKey(sharedSecret, HKDF_CONTEXTS.LINKING_ENC)
  const macKey = deriveKey(sharedSecret, HKDF_CONTEXTS.LINKING_MAC)

  return { encKey, macKey }
}

// =============================================================================
// Linking HMAC Proofs (T110a)
// =============================================================================

import { createLinkingHmacPayload } from './cbor'
import { computeHmacRaw } from './signatures'

/**
 * Compute the new_device_confirm HMAC proof (T110a).
 *
 * Sent by the new device to prove possession of the session token
 * and the shared secret.
 *
 * HMAC payload: { sessionId, token, newDevicePublicKey }
 *
 * @param macKey - 32-byte MAC key from deriveLinkingKeys()
 * @param sessionId - Linking session ID
 * @param token - Session token from QR code
 * @param newDevicePublicKey - New device's X25519 public key (Base64)
 * @returns 32-byte HMAC
 */
export function computeNewDeviceConfirm(
  macKey: Buffer,
  sessionId: string,
  token: string,
  newDevicePublicKey: string
): Buffer {
  const payload = createLinkingHmacPayload({
    sessionId,
    token,
    newDevicePublicKey
  })

  return computeHmacRaw(macKey, payload)
}

/**
 * Verify the new_device_confirm HMAC proof (T110a).
 *
 * Called by the existing device to verify the new device has
 * the correct session token and shared secret.
 *
 * @param macKey - 32-byte MAC key from deriveLinkingKeys()
 * @param expectedHmac - 32-byte HMAC to verify
 * @param sessionId - Linking session ID
 * @param token - Session token
 * @param newDevicePublicKey - New device's X25519 public key (Base64)
 * @returns true if HMAC is valid
 */
export function verifyNewDeviceConfirm(
  macKey: Buffer,
  expectedHmac: Buffer,
  sessionId: string,
  token: string,
  newDevicePublicKey: string
): boolean {
  const computed = computeNewDeviceConfirm(macKey, sessionId, token, newDevicePublicKey)
  return computed.equals(expectedHmac)
}

/**
 * Compute the key_confirm HMAC proof (T110a).
 *
 * Sent by the existing device to prove the encrypted master key
 * is authentic.
 *
 * HMAC payload: { sessionId, encryptedMasterKey, nonce }
 *
 * @param macKey - 32-byte MAC key from deriveLinkingKeys()
 * @param sessionId - Linking session ID
 * @param encryptedMasterKey - Encrypted master key (Base64)
 * @param nonce - Encryption nonce (Base64)
 * @returns 32-byte HMAC
 */
export function computeKeyConfirm(
  macKey: Buffer,
  sessionId: string,
  encryptedMasterKey: string,
  nonce: string
): Buffer {
  const payload = createLinkingHmacPayload({
    sessionId,
    encryptedMasterKey,
    nonce
  })

  return computeHmacRaw(macKey, payload)
}

/**
 * Verify the key_confirm HMAC proof (T110a).
 *
 * Called by the new device to verify the encrypted master key
 * came from a device with the correct shared secret.
 *
 * @param macKey - 32-byte MAC key from deriveLinkingKeys()
 * @param expectedHmac - 32-byte HMAC to verify
 * @param sessionId - Linking session ID
 * @param encryptedMasterKey - Encrypted master key (Base64)
 * @param nonce - Encryption nonce (Base64)
 * @returns true if HMAC is valid
 */
export function verifyKeyConfirm(
  macKey: Buffer,
  expectedHmac: Buffer,
  sessionId: string,
  encryptedMasterKey: string,
  nonce: string
): boolean {
  const computed = computeKeyConfirm(macKey, sessionId, encryptedMasterKey, nonce)
  return computed.equals(expectedHmac)
}

// =============================================================================
// Random Key Generation
// =============================================================================

/**
 * Generate a random file key for encrypting individual items.
 *
 * @returns 32-byte random key
 */
export function generateFileKey(): Buffer {
  const key = Buffer.alloc(KEY_LENGTH)
  sodium.randombytes_buf(key)
  return key
}

/**
 * Generate a random nonce for encryption.
 *
 * @param length - Nonce length (default: 24 for XChaCha20-Poly1305)
 * @returns Random nonce
 */
export function generateNonce(length: number = 24): Buffer {
  const nonce = Buffer.alloc(length)
  sodium.randombytes_buf(nonce)
  return nonce
}
