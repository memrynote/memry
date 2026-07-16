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
      // 413 covers two different problems. STORAGE_FILE_TOO_LARGE means this one
      // file is over the plan's per-file limit; a bare 413 means the account is
      // out of storage. Reporting "Storage quota exceeded" for the former sends
      // the user to free up space, which never fixes it.
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
      return {
        category: 'storage_quota_exceeded',
        message: 'Storage quota exceeded',
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
