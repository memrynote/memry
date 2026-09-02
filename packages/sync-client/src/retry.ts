import { NetworkError, RateLimitError, SyncServerError } from './http-errors'

export interface RetryOptions {
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
  jitterMs: number
  onRetry?: (attempt: number, error: Error, delayMs: number) => void
  signal?: AbortSignal
  isOnline?: () => boolean
  // When false, a 429 is treated like any other 4xx and thrown immediately
  // instead of being retried with backoff. Use for polling callers where the
  // poll cadence itself is the retry (otherwise each tick spawns its own
  // multi-attempt backoff storm). Defaults to retrying 429.
  retryOn429?: boolean
  // When false, a 5xx is thrown immediately instead of being retried. Use when
  // the caller can change the SHAPE of the request in response — retrying an
  // identical request first only burns the budget. The push path sends a
  // smaller batch: an oversized /sync/push is terminated by the edge before it
  // reaches the Worker, so every attempt at that size fails identically.
  // Defaults to retrying 5xx.
  retryOn5xx?: boolean
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

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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
        (error.statusCode !== 429 || opts.retryOn429 === false)
      ) {
        throw error
      }

      if (
        error instanceof SyncServerError &&
        error.statusCode >= 500 &&
        opts.retryOn5xx === false
      ) {
        throw error
      }

      if (attempt === opts.maxRetries) break

      let delayMs: number

      if (error instanceof RateLimitError && error.retryAfter !== undefined) {
        delayMs = error.retryAfter * 1000
      } else if (error instanceof NetworkError && !opts.isOnline!()) {
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
        // A NetworkError while isOnline() reports true means the machine has a
        // link but the server is unreachable (captive portal, DNS failure,
        // server down). The offline poll above never waits in that case, so
        // without this backoff the whole retry budget fires back-to-back in a
        // single tick and a two-second blip dead-letters the work.
        delayMs = computeBackoff(attempt, opts)
      }

      opts.onRetry?.(attempt + 1, lastError, delayMs)
      await sleep(delayMs, opts.signal)
    }
  }

  throw new DeadLetterError(lastError!, opts.maxRetries + 1)
}
