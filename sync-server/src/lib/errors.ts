import type { Context } from 'hono'

export const ErrorCodes = {
  AUTH_INVALID_TOKEN: 'AUTH_INVALID_TOKEN',
  AUTH_TOKEN_EXPIRED: 'AUTH_TOKEN_EXPIRED',
  AUTH_DEVICE_REVOKED: 'AUTH_DEVICE_REVOKED',
  AUTH_INVALID_OTP: 'AUTH_INVALID_OTP',
  AUTH_OTP_EXPIRED: 'AUTH_OTP_EXPIRED',
  AUTH_OTP_MAX_ATTEMPTS: 'AUTH_OTP_MAX_ATTEMPTS',
  AUTH_RATE_LIMITED: 'AUTH_RATE_LIMITED',
  AUTH_INVALID_PROVIDER: 'AUTH_INVALID_PROVIDER',
  AUTH_DEVICE_NOT_FOUND: 'AUTH_DEVICE_NOT_FOUND',

  SYNC_ITEM_NOT_FOUND: 'SYNC_ITEM_NOT_FOUND',
  SYNC_VERSION_CONFLICT: 'SYNC_VERSION_CONFLICT',
  SYNC_INVALID_SIGNATURE: 'SYNC_INVALID_SIGNATURE',
  SYNC_INVALID_CURSOR: 'SYNC_INVALID_CURSOR',
  SYNC_BATCH_TOO_LARGE: 'SYNC_BATCH_TOO_LARGE',
  SYNC_REPLAY_DETECTED: 'SYNC_REPLAY_DETECTED',

  CRYPTO_INVALID_PAYLOAD: 'CRYPTO_INVALID_PAYLOAD',
  CRYPTO_DECRYPTION_FAILED: 'CRYPTO_DECRYPTION_FAILED',
  CRYPTO_INVALID_VERSION: 'CRYPTO_INVALID_VERSION',

  STORAGE_QUOTA_EXCEEDED: 'STORAGE_QUOTA_EXCEEDED',
  STORAGE_BLOB_NOT_FOUND: 'STORAGE_BLOB_NOT_FOUND',
  STORAGE_UPLOAD_FAILED: 'STORAGE_UPLOAD_FAILED',
  STORAGE_UNAUTHORIZED: 'STORAGE_UNAUTHORIZED',
  STORAGE_VERSION_CONFLICT: 'STORAGE_VERSION_CONFLICT',
  STORAGE_HASH_MISMATCH: 'STORAGE_HASH_MISMATCH',

  VALIDATION_ERROR: 'VALIDATION_ERROR',
  VALIDATION_INVALID_EMAIL: 'VALIDATION_INVALID_EMAIL',
  VALIDATION_BODY_TOO_LARGE: 'VALIDATION_BODY_TOO_LARGE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED'
} as const

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes]

export class AppError extends Error {
  readonly code: ErrorCode
  readonly statusCode: number

  constructor(code: ErrorCode, message: string, statusCode = 500) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.statusCode = statusCode
  }
}

export const formatErrorResponse = (
  error: AppError
): { error: { code: ErrorCode; message: string } } => ({
  error: {
    code: error.code,
    message: error.message
  }
})

export const errorHandler = (err: Error, c: Context): Response => {
  if (err instanceof AppError) {
    return c.json(formatErrorResponse(err), { status: err.statusCode })
  }

  console.error('Unhandled error:', err.message)
  const fallback = new AppError(ErrorCodes.INTERNAL_ERROR, 'Internal server error', 500)
  return c.json(formatErrorResponse(fallback), 500)
}
