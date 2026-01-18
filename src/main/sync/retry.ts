/**
 * Retry Logic
 *
 * Provides exponential backoff with jitter for sync operations.
 * Categorizes errors into retryable vs permanent failures.
 *
 * Backoff schedule:
 * - Attempt 1: 1s (± 30% jitter)
 * - Attempt 2: 2s (± 30% jitter)
 * - Attempt 3: 4s (± 30% jitter)
 * - Attempt 4: 8s (± 30% jitter)
 * - Attempt 5: 16s (± 30% jitter)
 * - Attempt 6: 32s (± 30% jitter)
 * - Attempt 7+: 60s (capped, ± 30% jitter)
 *
 * @module main/sync/retry
 */

import { SyncApiError } from './api-client'

// =============================================================================
// Constants
// =============================================================================

/** Maximum number of retry attempts before permanent failure */
export const MAX_RETRY_ATTEMPTS = 10

/** Base delay in milliseconds (1 second) */
export const BASE_DELAY_MS = 1000

/** Maximum delay in milliseconds (60 seconds) */
export const MAX_DELAY_MS = 60000

/** Jitter factor (±30%) */
export const JITTER_FACTOR = 0.3

// =============================================================================
// Error Categories
// =============================================================================

/**
 * Error category for retry decisions.
 */
export enum ErrorCategory {
  /** Retryable: Network issues, server errors, rate limits */
  RETRYABLE = 'retryable',
  /** Permanent: Auth errors, validation errors, not found */
  PERMANENT = 'permanent',
  /** Unknown: Cannot determine, treat as retryable */
  UNKNOWN = 'unknown'
}

/**
 * Error codes that indicate permanent failures.
 * These errors should not be retried.
 */
const PERMANENT_ERROR_CODES = new Set([
  // HTTP status codes
  400, // Bad Request (validation error)
  401, // Unauthorized
  403, // Forbidden
  404, // Not Found
  409, // Conflict (but may need special handling)
  410, // Gone
  422, // Unprocessable Entity

  // Custom error codes (as strings)
  'VALIDATION_ERROR',
  'AUTH_ERROR',
  'NOT_FOUND',
  'FORBIDDEN',
  'CONFLICT',
  'ENCRYPTION_ERROR',
  'DECRYPTION_ERROR',
  'SIGNATURE_ERROR',
  'INVALID_PAYLOAD'
])

/**
 * Error codes that indicate retryable failures.
 */
const RETRYABLE_ERROR_CODES = new Set([
  // HTTP status codes
  408, // Request Timeout
  429, // Too Many Requests (rate limited)
  500, // Internal Server Error
  502, // Bad Gateway
  503, // Service Unavailable
  504, // Gateway Timeout

  // Custom error codes (as strings)
  'NETWORK_ERROR',
  'TIMEOUT',
  'RATE_LIMITED',
  'SERVER_ERROR',
  'UNAVAILABLE'
])

// =============================================================================
// Core Functions
// =============================================================================

/**
 * Calculate the delay before the next retry attempt.
 *
 * Uses exponential backoff with jitter to avoid thundering herd.
 *
 * @param attempt - Current attempt number (1-based)
 * @returns Delay in milliseconds before next retry
 *
 * @example
 * ```typescript
 * const delay = calculateNextRetry(1) // ~1000ms
 * const delay = calculateNextRetry(3) // ~4000ms
 * const delay = calculateNextRetry(7) // ~60000ms (capped)
 * ```
 */
export function calculateNextRetry(attempt: number): number {
  // Ensure attempt is at least 1
  const normalizedAttempt = Math.max(1, attempt)

  // Calculate base delay with exponential backoff: 2^(attempt-1) * BASE_DELAY
  const exponentialDelay = Math.pow(2, normalizedAttempt - 1) * BASE_DELAY_MS

  // Cap at maximum delay
  const cappedDelay = Math.min(exponentialDelay, MAX_DELAY_MS)

  // Add jitter (±JITTER_FACTOR%)
  const jitter = cappedDelay * JITTER_FACTOR * (Math.random() * 2 - 1)

  // Return delay with jitter, ensuring it's positive
  return Math.max(100, Math.round(cappedDelay + jitter))
}

/**
 * Categorize an error to determine if it should be retried.
 *
 * @param error - Error to categorize
 * @returns Error category
 */
export function categorizeError(error: unknown): ErrorCategory {
  // Handle SyncApiError
  if (error instanceof SyncApiError) {
    if (PERMANENT_ERROR_CODES.has(error.statusCode) || PERMANENT_ERROR_CODES.has(error.code)) {
      return ErrorCategory.PERMANENT
    }
    if (RETRYABLE_ERROR_CODES.has(error.statusCode) || RETRYABLE_ERROR_CODES.has(error.code)) {
      return ErrorCategory.RETRYABLE
    }
    // Default for unknown status codes: retry for 5xx, permanent for others
    return error.statusCode >= 500 ? ErrorCategory.RETRYABLE : ErrorCategory.PERMANENT
  }

  // Handle standard Error
  if (error instanceof Error) {
    const message = error.message.toLowerCase()

    // Network-related errors are retryable
    if (
      message.includes('network') ||
      message.includes('timeout') ||
      message.includes('econnreset') ||
      message.includes('econnrefused') ||
      message.includes('enotfound') ||
      message.includes('fetch failed') ||
      message.includes('socket') ||
      message.includes('abort')
    ) {
      return ErrorCategory.RETRYABLE
    }

    // Crypto errors are permanent
    if (
      message.includes('decrypt') ||
      message.includes('encrypt') ||
      message.includes('signature') ||
      message.includes('invalid key')
    ) {
      return ErrorCategory.PERMANENT
    }
  }

  // Unknown error type
  return ErrorCategory.UNKNOWN
}

/**
 * Check if an error is retryable.
 *
 * @param error - Error to check
 * @returns True if error should be retried
 */
export function isRetryableError(error: unknown): boolean {
  const category = categorizeError(error)
  // Treat unknown errors as retryable (optimistic)
  return category === ErrorCategory.RETRYABLE || category === ErrorCategory.UNKNOWN
}

/**
 * Check if an error is permanent (should not be retried).
 *
 * @param error - Error to check
 * @returns True if error is permanent
 */
export function isPermanentError(error: unknown): boolean {
  return categorizeError(error) === ErrorCategory.PERMANENT
}

/**
 * Check if we should continue retrying.
 *
 * @param attempt - Current attempt number (1-based)
 * @param error - Error from last attempt
 * @returns True if should retry
 */
export function shouldRetry(attempt: number, error: unknown): boolean {
  // Check attempt count
  if (attempt >= MAX_RETRY_ATTEMPTS) {
    return false
  }

  // Check error category
  return isRetryableError(error)
}

// =============================================================================
// Retry Executor
// =============================================================================

/**
 * Options for the retry executor.
 */
export interface RetryOptions {
  /** Maximum number of attempts (default: MAX_RETRY_ATTEMPTS) */
  maxAttempts?: number
  /** Called before each retry with attempt number and delay */
  onRetry?: (attempt: number, delay: number, error: unknown) => void
  /** Called when permanently failed */
  onPermanentFailure?: (error: unknown, attempts: number) => void
}

/**
 * Execute an operation with automatic retries.
 *
 * @param operation - Async operation to execute
 * @param options - Retry options
 * @returns Result of the operation
 * @throws Last error if all retries exhausted or permanent error
 *
 * @example
 * ```typescript
 * const result = await withRetry(
 *   async () => await fetchData(),
 *   {
 *     maxAttempts: 5,
 *     onRetry: (attempt, delay) => console.log(`Retry ${attempt} in ${delay}ms`),
 *   }
 * )
 * ```
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? MAX_RETRY_ATTEMPTS
  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error

      // Check if error is permanent
      if (isPermanentError(error)) {
        options.onPermanentFailure?.(error, attempt)
        throw error
      }

      // Check if we should retry
      if (attempt >= maxAttempts) {
        options.onPermanentFailure?.(error, attempt)
        throw error
      }

      // Calculate delay and wait
      const delay = calculateNextRetry(attempt)
      options.onRetry?.(attempt, delay, error)
      await sleep(delay)
    }
  }

  // Should never reach here, but TypeScript needs it
  throw lastError
}

// =============================================================================
// Utilities
// =============================================================================

/**
 * Sleep for a specified duration.
 *
 * @param ms - Duration in milliseconds
 * @returns Promise that resolves after the duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Get a human-readable description of the retry schedule.
 *
 * @param attempt - Current attempt number
 * @returns Human-readable string
 */
export function getRetryDescription(attempt: number): string {
  if (attempt >= MAX_RETRY_ATTEMPTS) {
    return 'No more retries (max attempts reached)'
  }

  const delay = calculateNextRetry(attempt)
  const seconds = Math.round(delay / 1000)

  if (seconds < 1) {
    return `Will retry in ${delay}ms`
  }

  return `Will retry in ${seconds} second${seconds > 1 ? 's' : ''}`
}
