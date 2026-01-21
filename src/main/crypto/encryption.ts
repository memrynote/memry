/**
 * Encryption Module
 *
 * Implements XChaCha20-Poly1305 authenticated encryption.
 */

import { ensureSodiumReady } from './sodium'
import { CryptoError, CryptoErrorCode } from './errors'
import { generateNonce, uint8ArrayToBase64, base64ToUint8Array } from './keys'
import { XCHACHA_PARAMS } from '@shared/contracts/crypto'
import type { EncryptionResult } from '@shared/contracts/crypto'

/**
 * Encrypt data using XChaCha20-Poly1305.
 *
 * @param plaintext - Data to encrypt
 * @param key - 32-byte encryption key
 * @param nonce - Optional 24-byte nonce (generated if not provided)
 * @returns Encrypted data with nonce
 * @throws CryptoError if encryption fails
 */
export async function encrypt(
  plaintext: Uint8Array,
  key: Uint8Array,
  nonce?: Uint8Array
): Promise<EncryptionResult> {
  const sodium = await ensureSodiumReady()

  if (key.length !== XCHACHA_PARAMS.keySize) {
    throw new CryptoError(
      `Invalid key length: expected ${XCHACHA_PARAMS.keySize} bytes, got ${key.length}`,
      CryptoErrorCode.INVALID_KEY_LENGTH
    )
  }

  const actualNonce = nonce ?? (await generateNonce())

  if (actualNonce.length !== XCHACHA_PARAMS.nonceSize) {
    throw new CryptoError(
      `Invalid nonce length: expected ${XCHACHA_PARAMS.nonceSize} bytes, got ${actualNonce.length}`,
      CryptoErrorCode.INVALID_NONCE_LENGTH
    )
  }

  try {
    const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      plaintext,
      null, // No additional authenticated data
      null, // No secret nonce
      actualNonce,
      key
    ) as Uint8Array

    return {
      ciphertext,
      nonce: actualNonce
    }
  } catch (error) {
    throw new CryptoError('Encryption failed', CryptoErrorCode.DECRYPTION_FAILED, error)
  }
}

/**
 * Decrypt data using XChaCha20-Poly1305.
 *
 * @param ciphertext - Encrypted data
 * @param nonce - 24-byte nonce used for encryption
 * @param key - 32-byte decryption key
 * @returns Decrypted data
 * @throws CryptoError if decryption fails (wrong key or tampered data)
 */
export async function decrypt(
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  key: Uint8Array
): Promise<Uint8Array> {
  const sodium = await ensureSodiumReady()

  if (key.length !== XCHACHA_PARAMS.keySize) {
    throw new CryptoError(
      `Invalid key length: expected ${XCHACHA_PARAMS.keySize} bytes, got ${key.length}`,
      CryptoErrorCode.INVALID_KEY_LENGTH
    )
  }

  if (nonce.length !== XCHACHA_PARAMS.nonceSize) {
    throw new CryptoError(
      `Invalid nonce length: expected ${XCHACHA_PARAMS.nonceSize} bytes, got ${nonce.length}`,
      CryptoErrorCode.INVALID_NONCE_LENGTH
    )
  }

  try {
    const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null, // No secret nonce
      ciphertext,
      null, // No additional authenticated data
      nonce,
      key
    ) as Uint8Array

    return plaintext
  } catch (error) {
    throw new CryptoError(
      'Decryption failed: wrong key or tampered data',
      CryptoErrorCode.DECRYPTION_FAILED,
      error
    )
  }
}

/**
 * Wrap a file key with the vault key.
 * Encrypts the file key for storage.
 *
 * @param fileKey - 32-byte file key to wrap
 * @param vaultKey - 32-byte vault key
 * @returns Object with Base64-encoded wrapped key and nonce
 */
export async function wrapFileKey(
  fileKey: Uint8Array,
  vaultKey: Uint8Array
): Promise<{ encryptedKey: string; keyNonce: string }> {
  const result = await encrypt(fileKey, vaultKey)

  return {
    encryptedKey: uint8ArrayToBase64(result.ciphertext),
    keyNonce: uint8ArrayToBase64(result.nonce)
  }
}

/**
 * Unwrap a file key with the vault key.
 * Decrypts the file key for use.
 *
 * @param encryptedKey - Base64-encoded wrapped key
 * @param keyNonce - Base64-encoded nonce
 * @param vaultKey - 32-byte vault key
 * @returns Unwrapped file key
 * @throws CryptoError if unwrapping fails
 */
export async function unwrapFileKey(
  encryptedKey: string,
  keyNonce: string,
  vaultKey: Uint8Array
): Promise<Uint8Array> {
  const ciphertext = base64ToUint8Array(encryptedKey)
  const nonce = base64ToUint8Array(keyNonce)

  return decrypt(ciphertext, nonce, vaultKey)
}

/**
 * Encrypt data with a new file key and wrap the file key.
 * Convenience function for encrypting an item.
 *
 * @param plaintext - Data to encrypt
 * @param fileKey - 32-byte file key
 * @param vaultKey - 32-byte vault key for wrapping
 * @returns Object with all encrypted data and nonces
 */
export async function encryptWithWrappedKey(
  plaintext: Uint8Array,
  fileKey: Uint8Array,
  vaultKey: Uint8Array
): Promise<{
  encryptedData: string
  dataNonce: string
  encryptedKey: string
  keyNonce: string
}> {
  // Encrypt the data with the file key
  const dataResult = await encrypt(plaintext, fileKey)

  // Wrap the file key with the vault key
  const wrappedKey = await wrapFileKey(fileKey, vaultKey)

  return {
    encryptedData: uint8ArrayToBase64(dataResult.ciphertext),
    dataNonce: uint8ArrayToBase64(dataResult.nonce),
    encryptedKey: wrappedKey.encryptedKey,
    keyNonce: wrappedKey.keyNonce
  }
}

/**
 * Decrypt data with a wrapped file key.
 * Convenience function for decrypting an item.
 *
 * @param encryptedData - Base64-encoded encrypted data
 * @param dataNonce - Base64-encoded data nonce
 * @param encryptedKey - Base64-encoded wrapped file key
 * @param keyNonce - Base64-encoded key nonce
 * @param vaultKey - 32-byte vault key for unwrapping
 * @returns Decrypted data
 */
export async function decryptWithWrappedKey(
  encryptedData: string,
  dataNonce: string,
  encryptedKey: string,
  keyNonce: string,
  vaultKey: Uint8Array
): Promise<Uint8Array> {
  // Unwrap the file key
  const fileKey = await unwrapFileKey(encryptedKey, keyNonce, vaultKey)

  // Decrypt the data
  const ciphertext = base64ToUint8Array(encryptedData)
  const nonce = base64ToUint8Array(dataNonce)

  return decrypt(ciphertext, nonce, fileKey)
}
