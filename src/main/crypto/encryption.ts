/**
 * XChaCha20-Poly1305 Encryption
 *
 * Implements authenticated encryption using XChaCha20-Poly1305 (AEAD).
 * This cipher provides both confidentiality and authenticity with a
 * 24-byte nonce (compared to ChaCha20's 12-byte nonce), making it
 * safe to use with random nonces.
 *
 * @module main/crypto/encryption
 */

import sodium from 'sodium-native'
import { type EncryptResult, CRYPTO_VERSION } from '@shared/contracts/crypto'
import { generateFileKey, generateNonce } from './keys'

// =============================================================================
// Constants
// =============================================================================

/** XChaCha20-Poly1305 nonce length (24 bytes) */
const NONCE_LENGTH = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES

/** XChaCha20-Poly1305 key length (32 bytes) */
const KEY_LENGTH = sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES

/** Authentication tag length (16 bytes) */
const TAG_LENGTH = sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES

// =============================================================================
// Basic Encryption/Decryption
// =============================================================================

/**
 * Encrypt data using XChaCha20-Poly1305.
 *
 * @param plaintext - Data to encrypt
 * @param key - 32-byte encryption key
 * @returns Encrypted data with nonce
 */
export function encrypt(plaintext: Buffer, key: Buffer): EncryptResult {
  if (key.length !== KEY_LENGTH) {
    throw new Error(`Key must be ${KEY_LENGTH} bytes, got ${key.length}`)
  }

  // Generate random nonce (24 bytes for XChaCha20)
  const nonce = generateNonce(NONCE_LENGTH)

  // Allocate ciphertext buffer (plaintext + auth tag)
  const ciphertext = Buffer.alloc(plaintext.length + TAG_LENGTH)

  // Encrypt with AEAD (no additional data)
  sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(ciphertext, plaintext, null, null, nonce, key)

  return {
    ciphertext: new Uint8Array(ciphertext),
    nonce: new Uint8Array(nonce)
  }
}

/**
 * Decrypt data using XChaCha20-Poly1305.
 *
 * @param ciphertext - Encrypted data (includes auth tag)
 * @param nonce - 24-byte nonce used for encryption
 * @param key - 32-byte encryption key
 * @returns Decrypted data
 * @throws Error if decryption fails (wrong key or tampered data)
 */
export function decrypt(ciphertext: Buffer, nonce: Buffer, key: Buffer): Buffer {
  if (key.length !== KEY_LENGTH) {
    throw new Error(`Key must be ${KEY_LENGTH} bytes, got ${key.length}`)
  }

  if (nonce.length !== NONCE_LENGTH) {
    throw new Error(`Nonce must be ${NONCE_LENGTH} bytes, got ${nonce.length}`)
  }

  if (ciphertext.length < TAG_LENGTH) {
    throw new Error('Ciphertext too short - missing auth tag')
  }

  // Allocate plaintext buffer
  const plaintext = Buffer.alloc(ciphertext.length - TAG_LENGTH)

  // Decrypt with AEAD verification
  try {
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(plaintext, null, ciphertext, null, nonce, key)
  } catch {
    throw new Error('Decryption failed - invalid ciphertext or key')
  }

  return plaintext
}

// =============================================================================
// File Key Wrapping
// =============================================================================

/**
 * Wrap (encrypt) a file key with the vault key.
 *
 * Each item has a unique random file key. The file key is encrypted
 * with the vault key (derived from master key) so it can be stored
 * alongside the encrypted data.
 *
 * @param fileKey - 32-byte file key to wrap
 * @param vaultKey - 32-byte vault key for wrapping
 * @returns Wrapped key with nonce
 */
export function wrapFileKey(fileKey: Buffer, vaultKey: Buffer): EncryptResult {
  return encrypt(fileKey, vaultKey)
}

/**
 * Unwrap (decrypt) a file key with the vault key.
 *
 * @param wrappedKey - Encrypted file key
 * @param nonce - Nonce used for encryption
 * @param vaultKey - 32-byte vault key
 * @returns 32-byte file key
 */
export function unwrapFileKey(wrappedKey: Buffer, nonce: Buffer, vaultKey: Buffer): Buffer {
  const fileKey = decrypt(wrappedKey, nonce, vaultKey)

  if (fileKey.length !== KEY_LENGTH) {
    throw new Error(`Unwrapped key has invalid length: ${fileKey.length}`)
  }

  return fileKey
}

// =============================================================================
// Item Encryption
// =============================================================================

/**
 * Encrypt an item with a new random file key.
 *
 * This is the main encryption function for sync items:
 * 1. Generate a random file key
 * 2. Encrypt the data with the file key
 * 3. Wrap the file key with the vault key
 *
 * @param data - Data to encrypt (Buffer or string)
 * @param vaultKey - 32-byte vault key
 * @returns Encrypted item with wrapped key
 */
export function encryptItem(
  data: Buffer | string,
  vaultKey: Buffer
): {
  encryptedData: Buffer
  dataNonce: Buffer
  encryptedKey: Buffer
  keyNonce: Buffer
  cryptoVersion: number
} {
  // Convert string to buffer if needed
  const plaintext = typeof data === 'string' ? Buffer.from(data, 'utf8') : data

  // Generate random file key for this item
  const fileKey = generateFileKey()

  // Encrypt data with file key
  const { ciphertext: encryptedData, nonce: dataNonce } = encrypt(plaintext, fileKey)

  // Wrap file key with vault key
  const { ciphertext: encryptedKey, nonce: keyNonce } = wrapFileKey(fileKey, vaultKey)

  // Zero out the file key from memory
  fileKey.fill(0)

  return {
    encryptedData: Buffer.from(encryptedData),
    dataNonce: Buffer.from(dataNonce),
    encryptedKey: Buffer.from(encryptedKey),
    keyNonce: Buffer.from(keyNonce),
    cryptoVersion: CRYPTO_VERSION
  }
}

/**
 * Decrypt an item using the vault key.
 *
 * This is the main decryption function for sync items:
 * 1. Unwrap the file key using the vault key
 * 2. Decrypt the data using the file key
 *
 * @param encryptedData - Encrypted data
 * @param dataNonce - Nonce for data encryption
 * @param encryptedKey - Wrapped file key
 * @param keyNonce - Nonce for key wrapping
 * @param vaultKey - 32-byte vault key
 * @returns Decrypted data
 */
export function decryptItem(
  encryptedData: Buffer,
  dataNonce: Buffer,
  encryptedKey: Buffer,
  keyNonce: Buffer,
  vaultKey: Buffer
): Buffer {
  // Unwrap the file key
  const fileKey = unwrapFileKey(encryptedKey, keyNonce, vaultKey)

  try {
    // Decrypt the data
    const plaintext = decrypt(encryptedData, dataNonce, fileKey)
    return plaintext
  } finally {
    // Zero out the file key from memory
    fileKey.fill(0)
  }
}

// =============================================================================
// Base64 Helpers
// =============================================================================

/**
 * Encrypt data and return Base64-encoded result.
 *
 * @param data - Data to encrypt
 * @param vaultKey - 32-byte vault key
 * @returns Object with Base64-encoded encrypted data and keys
 */
export function encryptItemToBase64(
  data: Buffer | string,
  vaultKey: Buffer
): {
  encryptedData: string
  dataNonce: string
  encryptedKey: string
  keyNonce: string
  cryptoVersion: number
} {
  const result = encryptItem(data, vaultKey)

  return {
    encryptedData: result.encryptedData.toString('base64'),
    dataNonce: result.dataNonce.toString('base64'),
    encryptedKey: result.encryptedKey.toString('base64'),
    keyNonce: result.keyNonce.toString('base64'),
    cryptoVersion: result.cryptoVersion
  }
}

/**
 * Decrypt Base64-encoded data.
 *
 * @param encryptedData - Base64-encoded encrypted data
 * @param dataNonce - Base64-encoded data nonce
 * @param encryptedKey - Base64-encoded wrapped key
 * @param keyNonce - Base64-encoded key nonce
 * @param vaultKey - 32-byte vault key
 * @returns Decrypted data as string
 */
export function decryptItemFromBase64(
  encryptedData: string,
  dataNonce: string,
  encryptedKey: string,
  keyNonce: string,
  vaultKey: Buffer
): string {
  const plaintext = decryptItem(
    Buffer.from(encryptedData, 'base64'),
    Buffer.from(dataNonce, 'base64'),
    Buffer.from(encryptedKey, 'base64'),
    Buffer.from(keyNonce, 'base64'),
    vaultKey
  )

  return plaintext.toString('utf8')
}

// =============================================================================
// Attachment Chunk Encryption
// =============================================================================

/**
 * Encrypt an attachment chunk.
 *
 * Attachments are split into chunks and each chunk is encrypted
 * with the same file key but a unique nonce.
 *
 * @param chunk - Chunk data to encrypt
 * @param fileKey - 32-byte file key for the attachment
 * @param chunkIndex - Index of this chunk (used to ensure unique nonces)
 * @returns Encrypted chunk with nonce
 */
export function encryptChunk(
  chunk: Buffer,
  fileKey: Buffer,
  _chunkIndex: number
): { ciphertext: Buffer; nonce: Buffer } {
  // Generate a random nonce for each chunk
  // (XChaCha20's 24-byte nonce makes collisions negligible)
  const result = encrypt(chunk, fileKey)

  return {
    ciphertext: Buffer.from(result.ciphertext),
    nonce: Buffer.from(result.nonce)
  }
}

/**
 * Decrypt an attachment chunk.
 *
 * @param ciphertext - Encrypted chunk
 * @param nonce - Nonce for this chunk
 * @param fileKey - 32-byte file key for the attachment
 * @returns Decrypted chunk data
 */
export function decryptChunk(ciphertext: Buffer, nonce: Buffer, fileKey: Buffer): Buffer {
  return decrypt(ciphertext, nonce, fileKey)
}

// =============================================================================
// Master Key Encryption for Device Linking (T111)
// =============================================================================

/**
 * Encrypt the master key for device linking (T111).
 *
 * Uses XChaCha20-Poly1305 with the linking encryption key derived
 * from the ECDH shared secret.
 *
 * @param masterKey - 32-byte master key to encrypt
 * @param encKey - 32-byte encryption key from deriveLinkingKeys()
 * @returns Object with ciphertext and nonce (both Buffers)
 */
export function encryptMasterKeyForLinking(
  masterKey: Buffer,
  encKey: Buffer
): { ciphertext: Buffer; nonce: Buffer } {
  if (masterKey.length !== KEY_LENGTH) {
    throw new Error(`Master key must be ${KEY_LENGTH} bytes, got ${masterKey.length}`)
  }

  const result = encrypt(masterKey, encKey)

  return {
    ciphertext: Buffer.from(result.ciphertext),
    nonce: Buffer.from(result.nonce)
  }
}

/**
 * Decrypt the master key received during device linking (T111).
 *
 * @param ciphertext - Encrypted master key
 * @param nonce - 24-byte nonce
 * @param encKey - 32-byte encryption key from deriveLinkingKeys()
 * @returns 32-byte master key
 * @throws Error if decryption fails
 */
export function decryptMasterKeyForLinking(
  ciphertext: Buffer,
  nonce: Buffer,
  encKey: Buffer
): Buffer {
  const masterKey = decrypt(ciphertext, nonce, encKey)

  if (masterKey.length !== KEY_LENGTH) {
    throw new Error(`Decrypted master key has invalid length: ${masterKey.length}`)
  }

  return masterKey
}
