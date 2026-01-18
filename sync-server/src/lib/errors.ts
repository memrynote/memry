/**
 * Custom error classes for the sync server
 *
 * @module lib/errors
 */

/**
 * Base class for all sync server errors
 */
export class SyncServerError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500,
    public code: string = 'INTERNAL_ERROR'
  ) {
    super(message)
    this.name = 'SyncServerError'
  }

  toJSON() {
    return {
      error: this.code,
      message: this.message,
      statusCode: this.statusCode
    }
  }
}

/**
 * Authentication errors (401)
 */
export class AuthenticationError extends SyncServerError {
  constructor(message: string = 'Authentication required') {
    super(message, 401, 'AUTHENTICATION_ERROR')
    this.name = 'AuthenticationError'
  }
}

/**
 * Authorization errors (403)
 */
export class AuthorizationError extends SyncServerError {
  constructor(message: string = 'Access denied') {
    super(message, 403, 'AUTHORIZATION_ERROR')
    this.name = 'AuthorizationError'
  }
}

/**
 * Not found errors (404)
 */
export class NotFoundError extends SyncServerError {
  constructor(resource: string = 'Resource') {
    super(`${resource} not found`, 404, 'NOT_FOUND')
    this.name = 'NotFoundError'
  }
}

/**
 * Validation errors (400)
 */
export class ValidationError extends SyncServerError {
  constructor(
    message: string = 'Validation failed',
    public details?: Record<string, string[]>
  ) {
    super(message, 400, 'VALIDATION_ERROR')
    this.name = 'ValidationError'
  }

  toJSON() {
    return {
      ...super.toJSON(),
      details: this.details
    }
  }
}

/**
 * Rate limit errors (429)
 */
export class RateLimitError extends SyncServerError {
  constructor(
    message: string = 'Too many requests',
    public retryAfter?: number
  ) {
    super(message, 429, 'RATE_LIMIT_EXCEEDED')
    this.name = 'RateLimitError'
  }
}

/**
 * Conflict errors (409)
 */
export class ConflictError extends SyncServerError {
  constructor(message: string = 'Resource conflict') {
    super(message, 409, 'CONFLICT')
    this.name = 'ConflictError'
  }
}

/**
 * Storage quota exceeded errors (507)
 */
export class StorageQuotaError extends SyncServerError {
  constructor(message: string = 'Storage quota exceeded') {
    super(message, 507, 'STORAGE_QUOTA_EXCEEDED')
    this.name = 'StorageQuotaError'
  }
}

/**
 * Linking session errors
 */
export class LinkingSessionError extends SyncServerError {
  constructor(
    message: string,
    code:
      | 'SESSION_EXPIRED'
      | 'SESSION_INVALID'
      | 'SESSION_ALREADY_USED'
      | 'DEVICE_LIMIT_REACHED' = 'SESSION_INVALID'
  ) {
    super(message, 400, code)
    this.name = 'LinkingSessionError'
  }
}

/**
 * Crypto verification errors
 */
export class CryptoVerificationError extends SyncServerError {
  constructor(message: string = 'Cryptographic verification failed') {
    super(message, 400, 'CRYPTO_VERIFICATION_FAILED')
    this.name = 'CryptoVerificationError'
  }
}
