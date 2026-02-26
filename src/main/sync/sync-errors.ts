import type { SyncErrorCategory } from '@shared/contracts/ipc-sync-ops'
import { CryptoError } from '../crypto/crypto-errors'
import { SyncServerError, NetworkError, RateLimitError } from './http-client'
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
