import type { SyncErrorCategory } from '@memry/contracts/ipc-sync-ops'
import { CryptoError } from '../crypto/crypto-errors'
import {
  SyncServerError,
  NetworkError,
  RateLimitError,
  AttachmentTooLargeError
} from './http-client'
import { DeadLetterError } from './retry'

export type { SyncErrorCategory }

export interface SyncErrorInfo {
  category: SyncErrorCategory
  message: string
  retryable: boolean
  /** HTTP status of the failed request, when the failure came from one. */
  statusCode?: number
  /**
   * The sync-server's structured `error.code` (VALIDATION_ERROR,
   * AUTH_INVALID_TOKEN, …) when the response carried one. Undefined is itself a
   * signal: a 5xx with no code never reached the Worker's error handler, so it
   * came from the edge and the backend has no record of it (#1584).
   */
  serverCode?: string
}

// `serverError` is `${code}: ${message}` when http-client read `error.code` off
// the body; the attachment upload path instead passes the raw JSON body through.
// Both shapes are read here so a code is never lost to the shape it arrived in.
const LEADING_SERVER_CODE = /^([A-Z][A-Z0-9_]{0,63}):/
const BODY_SERVER_CODE = /"code"\s*:\s*"([A-Z][A-Z0-9_]{0,63})"/

const serverErrorCode = (error: SyncServerError): string | undefined => {
  const source = error.serverError ?? error.message
  return LEADING_SERVER_CODE.exec(source)?.[1] ?? BODY_SERVER_CODE.exec(source)?.[1]
}

export function classifyError(error: unknown): SyncErrorInfo {
  if (error instanceof DeadLetterError) {
    const inner = classifyError(error.lastError)
    return { ...inner, retryable: false }
  }

  // Local plan preflight — same user-facing outcome as the server's 413, but
  // raised before the file is read and encrypted.
  if (error instanceof AttachmentTooLargeError) {
    return {
      category: 'file_too_large',
      message: error.message,
      retryable: false
    }
  }

  if (error instanceof RateLimitError) {
    return {
      category: 'rate_limited',
      message: error.message,
      retryable: true
    }
  }

  if (error instanceof SyncServerError) {
    // The label is deliberately unchanged: `category` drives the renderer's
    // error banner and every existing telemetry dashboard. What was missing
    // ships beside it — the exact status and the server's own error code, which
    // is what separates a permanent 400 VALIDATION_ERROR from a transient 503
    // and made `server_error` an undiagnosable catch-all (#1584).
    return {
      ...classifyServerError(error),
      statusCode: error.statusCode,
      serverCode: serverErrorCode(error)
    }
  }

  if (error instanceof NetworkError) {
    return {
      category: 'network_offline',
      message: error.message,
      retryable: true
    }
  }

  if (error instanceof CryptoError) {
    return {
      category: 'crypto_failure',
      message: error.message,
      retryable: false
    }
  }

  const message = error instanceof Error ? error.message : String(error)
  return {
    category: 'unknown',
    message,
    retryable: true
  }
}

/**
 * The category/message/retryable half of a server failure. Split out of
 * `classifyError` so the status and server code can be attached at one place
 * rather than repeated across every branch; the branch logic itself is
 * unchanged.
 */
function classifyServerError(error: SyncServerError): SyncErrorInfo {
  if (error.statusCode === 401) {
    return {
      category: 'auth_expired',
      message: 'Session expired',
      retryable: false
    }
  }
  if (error.statusCode === 403 && error.serverError?.includes('AUTH_DEVICE_REVOKED')) {
    return {
      category: 'device_revoked',
      message: 'This device has been removed',
      retryable: false
    }
  }
  if (error.statusCode === 402 || error.serverError?.includes('SYNC_PAYMENT_REQUIRED')) {
    return {
      category: 'sync_payment_required',
      message: 'A paid Sync plan is required',
      retryable: false
    }
  }
  if (error.statusCode === 426) {
    return {
      category: 'version_incompatible',
      message: error.serverError ?? 'App update required',
      retryable: false
    }
  }
  if (error.statusCode === 413) {
    // 413 covers three different problems. STORAGE_FILE_TOO_LARGE means this
    // one file is over the plan's per-file limit; STORAGE_QUOTA_EXCEEDED
    // means the account is out of storage; anything else (the body-limit
    // middleware's VALIDATION_BODY_TOO_LARGE, or a bare edge-proxy 413) means
    // a single payload is too big. Real quota responses always carry their
    // code, so only they may report "storage full" — anything else would send
    // the user to free up space, which never fixes a payload problem.
    if (
      error.serverError?.includes('STORAGE_FILE_TOO_LARGE') ||
      error.message.includes('STORAGE_FILE_TOO_LARGE')
    ) {
      return {
        category: 'file_too_large',
        message: 'This file is larger than your plan allows',
        retryable: false
      }
    }
    if (
      error.serverError?.includes('STORAGE_QUOTA_EXCEEDED') ||
      error.message.includes('STORAGE_QUOTA_EXCEEDED')
    ) {
      return {
        category: 'storage_quota_exceeded',
        message: 'Storage quota exceeded',
        retryable: false
      }
    }
    return {
      category: 'note_too_large',
      message: 'A note is too large to sync',
      retryable: false
    }
  }
  if (error.statusCode === 429) {
    return {
      category: 'rate_limited',
      message: error.message,
      retryable: true
    }
  }
  if (error.statusCode >= 500) {
    return {
      category: 'server_error',
      message: error.serverError ?? error.message,
      retryable: true
    }
  }
  return {
    category: 'server_error',
    message: error.serverError ?? error.message,
    retryable: false
  }
}
