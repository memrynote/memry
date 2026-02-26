export type CryptoErrorCode =
  | 'INVALID_KEY_LENGTH'
  | 'INVALID_NONCE_LENGTH'
  | 'DECRYPTION_FAILED'
  | 'ENCRYPTION_FAILED'

export class CryptoError extends Error {
  readonly code: CryptoErrorCode

  constructor(code: CryptoErrorCode, message: string) {
    super(message)
    this.name = 'CryptoError'
    this.code = code
  }
}
