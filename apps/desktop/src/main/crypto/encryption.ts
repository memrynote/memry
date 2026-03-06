import sodium from 'libsodium-wrappers-sumo'

import { XCHACHA20_PARAMS } from '@memry/contracts/crypto'
import { CryptoError } from './crypto-errors'

export const generateNonce = (): Uint8Array => {
  const nonce = sodium.randombytes_buf(XCHACHA20_PARAMS.NONCE_LENGTH)

  if (nonce.length !== XCHACHA20_PARAMS.NONCE_LENGTH) {
    throw new Error(
      `Nonce length mismatch: expected ${XCHACHA20_PARAMS.NONCE_LENGTH}, got ${nonce.length}`
    )
  }

  return nonce
}

export const encrypt = (
  plaintext: Uint8Array,
  key: Uint8Array,
  associatedData?: Uint8Array
): { ciphertext: Uint8Array; nonce: Uint8Array } => {
  if (key.length !== XCHACHA20_PARAMS.KEY_LENGTH) {
    throw new CryptoError(
      'INVALID_KEY_LENGTH',
      `Expected key length ${XCHACHA20_PARAMS.KEY_LENGTH}, got ${key.length}`
    )
  }

  const nonce = generateNonce()

  try {
    const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      plaintext,
      associatedData ?? null,
      null,
      nonce,
      key
    )
    return { ciphertext, nonce }
  } catch (err) {
    throw new CryptoError(
      'ENCRYPTION_FAILED',
      err instanceof Error ? err.message : 'Encryption failed'
    )
  }
}

export const decrypt = (
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  key: Uint8Array,
  associatedData?: Uint8Array
): Uint8Array => {
  if (key.length !== XCHACHA20_PARAMS.KEY_LENGTH) {
    throw new CryptoError(
      'INVALID_KEY_LENGTH',
      `Expected key length ${XCHACHA20_PARAMS.KEY_LENGTH}, got ${key.length}`
    )
  }
  if (nonce.length !== XCHACHA20_PARAMS.NONCE_LENGTH) {
    throw new CryptoError(
      'INVALID_NONCE_LENGTH',
      `Expected nonce length ${XCHACHA20_PARAMS.NONCE_LENGTH}, got ${nonce.length}`
    )
  }

  try {
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ciphertext,
      associatedData ?? null,
      nonce,
      key
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Decryption failed'
    throw new CryptoError(
      'DECRYPTION_FAILED',
      msg.toLowerCase().includes('ciphertext') || msg.toLowerCase().includes('mac')
        ? `Ciphertext authentication failed: ${msg}`
        : msg
    )
  }
}

export const wrapFileKey = (
  fileKey: Uint8Array,
  vaultKey: Uint8Array
): { wrappedKey: Uint8Array; nonce: Uint8Array } => {
  const result = encrypt(fileKey, vaultKey)
  return { wrappedKey: result.ciphertext, nonce: result.nonce }
}

export const unwrapFileKey = (
  wrappedKey: Uint8Array,
  nonce: Uint8Array,
  vaultKey: Uint8Array
): Uint8Array => {
  const fileKey = decrypt(wrappedKey, nonce, vaultKey)

  try {
    return new Uint8Array(fileKey)
  } finally {
    sodium.memzero(fileKey)
  }
}

// ============================================================================
// Device Linking — Master key transfer via ephemeral ECDH channel
// ============================================================================

export const encryptMasterKeyForLinking = (
  masterKey: Uint8Array,
  encKey: Uint8Array
): { ciphertext: Uint8Array; nonce: Uint8Array } => {
  return encrypt(masterKey, encKey)
}

export const decryptMasterKeyFromLinking = (
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  encKey: Uint8Array
): Uint8Array => {
  return decrypt(ciphertext, nonce, encKey)
}
