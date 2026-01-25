/**
 * Crypto Module
 *
 * End-to-end encryption primitives for Memry sync.
 *
 * This module provides:
 * - BIP39 recovery phrase generation and validation
 * - Argon2id master key derivation
 * - HKDF sub-key derivation
 * - XChaCha20-Poly1305 encryption/decryption
 * - Ed25519 signing and verification
 * - OS keychain storage
 * - Canonical CBOR encoding for signatures
 */

import { ensureSodiumReady, getSodium } from './sodium'

// Re-export errors
export { CryptoError, CryptoErrorCode, isCryptoError } from './errors'

// Re-export sodium initialization
export { ensureSodiumReady, isSodiumInitialized } from './sodium'

// Re-export CBOR encoding
export { encodeCanonicalCbor, encodeSignaturePayloadV1, decodeCbor } from './cbor'

// Re-export recovery phrase functions
export {
  generateRecoveryPhrase,
  validateRecoveryPhrase,
  phraseToEntropy,
  entropyToPhrase
} from './recovery'

// Re-export key derivation functions
export {
  deriveKey,
  deriveMasterKey,
  deriveAllKeys,
  generateFileKey,
  generateDeviceSigningKeyPair,
  getDevicePublicKeyBase64,
  generateSalt,
  generateNonce,
  uint8ArrayToBase64,
  base64ToUint8Array,
  generateKeyVerifier,
  deriveVaultKey,
  deriveSigningKeyPair,
  deriveVerifyKey,
  constantTimeEqual,
  generateLinkingKeyPair,
  deriveLinkingKeys,
  computeLinkingProof,
  verifyLinkingProof
} from './keys'

// Re-export encryption functions
export {
  encrypt,
  decrypt,
  wrapFileKey,
  unwrapFileKey,
  encryptWithWrappedKey,
  decryptWithWrappedKey,
  encryptMasterKeyForLinking,
  decryptMasterKeyFromLinking
} from './encryption'

// Re-export signature functions
export { signPayload, verifyPayload, sign, verify, signPayloadBase64 } from './signatures'

// Re-export keychain functions
export {
  storeKeyMaterial,
  retrieveKeyMaterial,
  deleteKeyMaterial,
  storeDeviceKeyPair,
  retrieveDeviceKeyPair,
  deleteDeviceKeyPair,
  hasKeyMaterial,
  hasDeviceKeyPair,
  deleteAllKeys,
  storeAuthTokens,
  retrieveAuthTokens,
  deleteAuthTokens,
  storeSigningKeyPair,
  retrieveSigningKeyPair,
  deleteSigningKeyPair
} from './keychain'

// Re-export keychain types
export type { StoredAuthTokens, StoredSigningKeyPair } from './keychain'

/**
 * Securely zero out sensitive memory.
 * Should be called after using key material to prevent memory leaks.
 *
 * @param data - The data to zero out (will be modified in place)
 */
export async function secureZero(data: Uint8Array): Promise<void> {
  const sodium = await ensureSodiumReady()
  sodium.memzero(data)
}

/**
 * Synchronous version of secureZero.
 * Only use after ensureSodiumReady() has been called.
 *
 * @param data - The data to zero out (will be modified in place)
 */
export function secureZeroSync(data: Uint8Array): void {
  // Use sodium directly since it should already be initialized
  // when this function is called
  const sodium = getSodium()
  sodium.memzero(data)
}

/**
 * Initialize the crypto module.
 * Should be called once at application startup.
 *
 * @returns Promise that resolves when crypto is ready
 */
export async function initCrypto(): Promise<void> {
  await ensureSodiumReady()
}
