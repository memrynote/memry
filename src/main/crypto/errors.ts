/**
 * Crypto Module Errors
 *
 * Error codes and error class for cryptographic operations.
 */

/**
 * Error codes for crypto operations
 */
export const CryptoErrorCode = {
  /** Sodium library not initialized */
  SODIUM_NOT_READY: 'CRYPTO_SODIUM_NOT_READY',

  /** Invalid key length provided */
  INVALID_KEY_LENGTH: 'CRYPTO_INVALID_KEY_LENGTH',

  /** Invalid nonce length provided */
  INVALID_NONCE_LENGTH: 'CRYPTO_INVALID_NONCE_LENGTH',

  /** Decryption failed (wrong key or tampered data) */
  DECRYPTION_FAILED: 'CRYPTO_DECRYPTION_FAILED',

  /** Encryption failed */
  ENCRYPTION_FAILED: 'CRYPTO_ENCRYPTION_FAILED',

  /** Signature verification failed */
  SIGNATURE_INVALID: 'CRYPTO_SIGNATURE_INVALID',

  /** OS keychain operation failed */
  KEYCHAIN_ERROR: 'CRYPTO_KEYCHAIN_ERROR',

  /** Invalid BIP39 recovery phrase */
  INVALID_RECOVERY_PHRASE: 'CRYPTO_INVALID_RECOVERY_PHRASE',

  /** Key derivation failed */
  KEY_DERIVATION_FAILED: 'CRYPTO_KEY_DERIVATION_FAILED',

  /** CBOR encoding/decoding failed */
  ENCODING_FAILED: 'CRYPTO_ENCODING_FAILED',

  /** Key not found in keychain */
  KEY_NOT_FOUND: 'CRYPTO_KEY_NOT_FOUND',

  /** Invalid signature payload */
  INVALID_PAYLOAD: 'CRYPTO_INVALID_PAYLOAD',

  /** Key generation failed */
  KEY_GENERATION_FAILED: 'CRYPTO_KEY_GENERATION_FAILED',

  /** HMAC computation failed */
  HMAC_FAILED: 'CRYPTO_HMAC_FAILED'
} as const

export type CryptoErrorCode = (typeof CryptoErrorCode)[keyof typeof CryptoErrorCode]

/**
 * Error for cryptographic operations.
 */
export class CryptoError extends Error {
  constructor(
    message: string,
    public code: CryptoErrorCode,
    public cause?: unknown
  ) {
    super(message)
    this.name = 'CryptoError'
  }
}

/**
 * Type guard to check if an error is a CryptoError
 */
export function isCryptoError(error: unknown): error is CryptoError {
  return error instanceof CryptoError
}
