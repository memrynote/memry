import { NetworkError, RateLimitError, SyncServerError } from './http-client'

export interface RetryOptions {
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
  jitterMs: number
  onRetry?: (attempt: number, error: Error, delayMs: number) => void
  signal?: AbortSignal
  isOnline?: () => boolean
}

export interface RetryResult<T> {
  value: T
  attempts: number
}

export class DeadLetterError extends Error {
  constructor(
    public readonly lastError: Error,
    public readonly attempts: number
  ) {
    super(`Dead letter after ${attempts} attempts: ${lastError.message}`)
    this.name = 'DeadLetterError'
  }
}

const DEFAULTS: RetryOptions = {
  maxRetries: 5,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  jitterMs: 500,
  isOnline: () => true
}

const ONLINE_POLL_MS = 2000
const MAX_OFFLINE_WAIT_MS = 5 * 60 * 1000

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('The operation was aborted.', 'AbortError'))
      return
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    function onAbort(): void {
      clearTimeout(timer)
      reject(new DOMException('The operation was aborted.', 'AbortError'))
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function computeBackoff(attempt: number, opts: RetryOptions): number {
  const exponential = opts.baseDelayMs * Math.pow(2, attempt)
  const jitter = Math.random() * opts.jitterMs
  return Math.min(exponential + jitter, opts.maxDelayMs)
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: Partial<RetryOptions>
): Promise<RetryResult<T>> {
  const opts = { ...DEFAULTS, ...options }
  let lastError: Error | undefined

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    if (opts.signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError')
    }

    try {
      const value = await fn()
      return { value, attempts: attempt + 1 }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))

      if (
        error instanceof SyncServerError &&
        error.statusCode >= 400 &&
        error.statusCode < 500 &&
        error.statusCode !== 429
      ) {
        throw error
      }

      if (attempt === opts.maxRetries) break

      let delayMs: number

      if (error instanceof RateLimitError && error.retryAfter !== undefined) {
        delayMs = error.retryAfter * 1000
      } else if (error instanceof NetworkError) {
        opts.onRetry?.(attempt + 1, lastError, ONLINE_POLL_MS)
        const offlineStart = Date.now()
        while (!opts.isOnline!()) {
          if (Date.now() - offlineStart > MAX_OFFLINE_WAIT_MS) {
            throw new NetworkError('Offline wait timeout exceeded')
          }
          await sleep(ONLINE_POLL_MS, opts.signal)
        }
        continue
      } else {
        delayMs = computeBackoff(attempt, opts)
      }

      opts.onRetry?.(attempt + 1, lastError, delayMs)
      await sleep(delayMs, opts.signal)
    }
  }

  throw new DeadLetterError(lastError!, opts.maxRetries + 1)
}
