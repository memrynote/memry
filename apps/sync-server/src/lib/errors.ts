import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { Context } from 'hono'

import { createLogger } from './logger'
import { captureServerError } from '../services/analytics'
import type { AppContext } from '../types'

const logger = createLogger('ErrorHandler')

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
  AUTH_TOKEN_ROTATION_FAILED: 'AUTH_TOKEN_ROTATION_FAILED',

  LINKING_SESSION_NOT_FOUND: 'LINKING_SESSION_NOT_FOUND',
  LINKING_SESSION_EXPIRED: 'LINKING_SESSION_EXPIRED',
  LINKING_INVALID_TRANSITION: 'LINKING_INVALID_TRANSITION',
  LINKING_DUPLICATE_SESSION: 'LINKING_DUPLICATE_SESSION',
  LINKING_CONCURRENT_ATTEMPT: 'LINKING_CONCURRENT_ATTEMPT',
  LINKING_SECRET_INVALID: 'LINKING_SECRET_INVALID',
  LINKING_IP_MISMATCH: 'LINKING_IP_MISMATCH',

  SYNC_ITEM_NOT_FOUND: 'SYNC_ITEM_NOT_FOUND',
  SYNC_VERSION_CONFLICT: 'SYNC_VERSION_CONFLICT',
  SYNC_INVALID_SIGNATURE: 'SYNC_INVALID_SIGNATURE',
  SYNC_INVALID_CURSOR: 'SYNC_INVALID_CURSOR',
  SYNC_BATCH_TOO_LARGE: 'SYNC_BATCH_TOO_LARGE',
  SYNC_REPLAY_DETECTED: 'SYNC_REPLAY_DETECTED',
  SYNC_VERSION_INCOMPATIBLE: 'SYNC_VERSION_INCOMPATIBLE',
  SYNC_PAYMENT_REQUIRED: 'SYNC_PAYMENT_REQUIRED',
  SYNC_VAULT_LIMIT_EXCEEDED: 'SYNC_VAULT_LIMIT_EXCEEDED',
  SYNC_VAULT_NOT_FOUND: 'SYNC_VAULT_NOT_FOUND',

  CRYPTO_INVALID_PAYLOAD: 'CRYPTO_INVALID_PAYLOAD',
  CRYPTO_DECRYPTION_FAILED: 'CRYPTO_DECRYPTION_FAILED',
  CRYPTO_INVALID_VERSION: 'CRYPTO_INVALID_VERSION',

  STORAGE_QUOTA_EXCEEDED: 'STORAGE_QUOTA_EXCEEDED',
  STORAGE_FILE_TOO_LARGE: 'STORAGE_FILE_TOO_LARGE',
  STORAGE_BLOB_NOT_FOUND: 'STORAGE_BLOB_NOT_FOUND',
  STORAGE_UPLOAD_FAILED: 'STORAGE_UPLOAD_FAILED',
  STORAGE_UNAUTHORIZED: 'STORAGE_UNAUTHORIZED',
  STORAGE_VERSION_CONFLICT: 'STORAGE_VERSION_CONFLICT',
  STORAGE_HASH_MISMATCH: 'STORAGE_HASH_MISMATCH',
  // Presigned R2 URLs are not configured on this deployment (secrets absent) —
  // a typed, permanent signal so clients fall back to the proxied blob paths.
  STORAGE_PRESIGN_UNAVAILABLE: 'STORAGE_PRESIGN_UNAVAILABLE',

  UPLOAD_SESSION_NOT_FOUND: 'UPLOAD_SESSION_NOT_FOUND',
  UPLOAD_SESSION_EXPIRED: 'UPLOAD_SESSION_EXPIRED',
  UPLOAD_CHUNK_CONFLICT: 'UPLOAD_CHUNK_CONFLICT',
  UPLOAD_INCOMPLETE: 'UPLOAD_INCOMPLETE',
  ATTACHMENT_NOT_FOUND: 'ATTACHMENT_NOT_FOUND',

  CLIENT_UPGRADE_REQUIRED: 'CLIENT_UPGRADE_REQUIRED',
  PLATFORM_WRITES_DISABLED: 'PLATFORM_WRITES_DISABLED',

  VALIDATION_ERROR: 'VALIDATION_ERROR',
  VALIDATION_INVALID_EMAIL: 'VALIDATION_INVALID_EMAIL',
  VALIDATION_BODY_TOO_LARGE: 'VALIDATION_BODY_TOO_LARGE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',

  WS_RATE_LIMITED: 'WS_RATE_LIMITED',
  WS_TOKEN_EXPIRED: 'WS_TOKEN_EXPIRED',
  WS_INVALID_CONNECTION: 'WS_INVALID_CONNECTION'
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

const scheduleServerErrorCapture = (
  err: Error,
  c: Context<AppContext>,
  metadata: {
    statusCode: number
    errorCode: string
    handled: boolean
  }
): void => {
  if (!c.req) return

  let executionCtx: { waitUntil?: (promise: Promise<unknown>) => void } | undefined
  try {
    executionCtx = c.executionCtx
  } catch {
    return
  }
  if (!executionCtx?.waitUntil) return

  executionCtx.waitUntil(
    captureServerError(c.env, {
      error: err,
      method: c.req.method,
      path: c.req.path,
      source: 'ErrorHandler',
      action: 'request_failed',
      statusCode: metadata.statusCode,
      errorCode: metadata.errorCode,
      handled: metadata.handled,
      userId: c.get('userId'),
      deviceId: c.get('deviceId'),
      vaultId: c.get('vaultId')
    })
  )
}

export const errorHandler = (err: Error, c: Context<AppContext>): Response => {
  if (err instanceof AppError) {
    scheduleServerErrorCapture(err, c, {
      statusCode: err.statusCode,
      errorCode: err.code,
      handled: true
    })
    return c.json(formatErrorResponse(err), { status: err.statusCode as ContentfulStatusCode })
  }

  logger.error(err.message, { code: 'UNHANDLED_ERROR', stack: err.stack })
  scheduleServerErrorCapture(err, c, {
    statusCode: 500,
    errorCode: 'UNHANDLED_ERROR',
    handled: false
  })
  const fallback = new AppError(ErrorCodes.INTERNAL_ERROR, 'Internal server error', 500)
  return c.json(formatErrorResponse(fallback), 500)
}
