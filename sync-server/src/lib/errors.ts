/**
 * T033: Base Error Handling
 *
 * Defines error codes and SyncError class for consistent error handling
 * across the sync server.
 */

/**
 * Error codes for categorized error handling.
 * Follows a domain-based naming convention.
 */
export const ErrorCode = {
  // Auth errors
  AUTH_INVALID_TOKEN: 'AUTH_INVALID_TOKEN',
  AUTH_TOKEN_EXPIRED: 'AUTH_TOKEN_EXPIRED',
  AUTH_UNAUTHORIZED: 'AUTH_UNAUTHORIZED',
  AUTH_FORBIDDEN: 'AUTH_FORBIDDEN',
  AUTH_DEVICE_NOT_FOUND: 'AUTH_DEVICE_NOT_FOUND',
  AUTH_OTP_INVALID: 'AUTH_OTP_INVALID',
  AUTH_OTP_EXPIRED: 'AUTH_OTP_EXPIRED',
  AUTH_OTP_MAX_ATTEMPTS: 'AUTH_OTP_MAX_ATTEMPTS',
  AUTH_RATE_LIMITED: 'AUTH_RATE_LIMITED',
  AUTH_REFRESH_TOKEN_INVALID: 'AUTH_REFRESH_TOKEN_INVALID',
  AUTH_REFRESH_TOKEN_EXPIRED: 'AUTH_REFRESH_TOKEN_EXPIRED',
  AUTH_REFRESH_TOKEN_REVOKED: 'AUTH_REFRESH_TOKEN_REVOKED',

  // Sync errors
  SYNC_INVALID_REQUEST: 'SYNC_INVALID_REQUEST',
  SYNC_CONFLICT: 'SYNC_CONFLICT',
  SYNC_ITEM_NOT_FOUND: 'SYNC_ITEM_NOT_FOUND',
  SYNC_SIGNATURE_INVALID: 'SYNC_SIGNATURE_INVALID',
  SYNC_CURSOR_INVALID: 'SYNC_CURSOR_INVALID',

  // Crypto errors
  CRYPTO_INVALID_SIGNATURE: 'CRYPTO_INVALID_SIGNATURE',
  CRYPTO_ENCODING_FAILED: 'CRYPTO_ENCODING_FAILED',

  // Storage errors
  STORAGE_QUOTA_EXCEEDED: 'STORAGE_QUOTA_EXCEEDED',
  STORAGE_BLOB_NOT_FOUND: 'STORAGE_BLOB_NOT_FOUND',

  // Server errors
  SERVER_INTERNAL_ERROR: 'SERVER_INTERNAL_ERROR',
  SERVER_DATABASE_ERROR: 'SERVER_DATABASE_ERROR',
  SERVER_VALIDATION_ERROR: 'SERVER_VALIDATION_ERROR',
} as const

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

/**
 * Custom error class for sync server errors.
 * Includes error code and HTTP status code for API responses.
 */
export class SyncError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode,
    public readonly statusCode: number = 500,
    public readonly details?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'SyncError'
  }

  /**
   * Convert to JSON-serializable object for API responses.
   */
  toJSON(): Record<string, unknown> {
    return {
      error: this.code,
      message: this.message,
      ...(this.details && { details: this.details }),
    }
  }
}

// Factory functions for common errors

export const unauthorized = (message?: string): SyncError =>
  new SyncError(message ?? 'Unauthorized', ErrorCode.AUTH_UNAUTHORIZED, 401)

export const forbidden = (message?: string): SyncError =>
  new SyncError(message ?? 'Forbidden', ErrorCode.AUTH_FORBIDDEN, 403)

export const notFound = (resource: string): SyncError =>
  new SyncError(`${resource} not found`, ErrorCode.SYNC_ITEM_NOT_FOUND, 404)

export const rateLimited = (retryAfter: number): SyncError =>
  new SyncError('Rate limit exceeded', ErrorCode.AUTH_RATE_LIMITED, 429, { retryAfter })

export const conflict = (details: Record<string, unknown>): SyncError =>
  new SyncError('Sync conflict', ErrorCode.SYNC_CONFLICT, 409, details)

export const badRequest = (message: string, details?: Record<string, unknown>): SyncError =>
  new SyncError(message, ErrorCode.SYNC_INVALID_REQUEST, 400, details)

export const validationError = (message: string, details?: Record<string, unknown>): SyncError =>
  new SyncError(message, ErrorCode.SERVER_VALIDATION_ERROR, 400, details)

export const internalError = (message?: string): SyncError =>
  new SyncError(message ?? 'Internal server error', ErrorCode.SERVER_INTERNAL_ERROR, 500)

export const databaseError = (message?: string): SyncError =>
  new SyncError(message ?? 'Database error', ErrorCode.SERVER_DATABASE_ERROR, 500)

export const tokenExpired = (): SyncError =>
  new SyncError('Token has expired', ErrorCode.AUTH_TOKEN_EXPIRED, 401)

export const invalidToken = (message?: string): SyncError =>
  new SyncError(message ?? 'Invalid token', ErrorCode.AUTH_INVALID_TOKEN, 401)

export const otpInvalid = (): SyncError =>
  new SyncError('Invalid OTP code', ErrorCode.AUTH_OTP_INVALID, 400)

export const otpExpired = (): SyncError =>
  new SyncError('OTP code has expired', ErrorCode.AUTH_OTP_EXPIRED, 400)

export const otpMaxAttempts = (): SyncError =>
  new SyncError('Maximum OTP verification attempts exceeded', ErrorCode.AUTH_OTP_MAX_ATTEMPTS, 429)

export const refreshTokenInvalid = (): SyncError =>
  new SyncError('Invalid refresh token', ErrorCode.AUTH_REFRESH_TOKEN_INVALID, 401)

export const refreshTokenExpired = (): SyncError =>
  new SyncError('Refresh token has expired', ErrorCode.AUTH_REFRESH_TOKEN_EXPIRED, 401)

export const refreshTokenRevoked = (): SyncError =>
  new SyncError('Refresh token has been revoked', ErrorCode.AUTH_REFRESH_TOKEN_REVOKED, 401)

/**
 * Type guard to check if an error is a SyncError.
 */
export const isSyncError = (err: unknown): err is SyncError => err instanceof SyncError
