/**
 * Provider-neutral error taxonomy (#1391). Adapters throw these; the engine
 * and runners decide what to do by class, never by sniffing a provider's
 * status codes or bodies. Existing provider codes (`IcsFeedError`, Google's
 * 410) map onto these through `classifyProviderError`; they are not replaced.
 */
export type ProviderErrorKind = 'auth' | 'gone' | 'conflict' | 'rate_limit' | 'transient'

export abstract class ProviderError extends Error {
  abstract readonly kind: ProviderErrorKind

  constructor(
    message: string,
    readonly providerId: string,
    options?: { cause?: unknown }
  ) {
    super(message, options)
  }
}

/** Credentials rejected or revoked. The account shows `reconnect_required`. */
export class ProviderAuthError extends ProviderError {
  readonly kind = 'auth' as const
  readonly status: number | null

  constructor(
    providerId: string,
    message = 'Calendar provider rejected the credentials',
    options?: { cause?: unknown; status?: number }
  ) {
    super(message, providerId, options)
    this.name = 'ProviderAuthError'
    this.status = options?.status ?? null
  }
}

/** The incremental cursor is no longer valid: clear it and resync in full. */
export class ProviderGoneError extends ProviderError {
  readonly kind = 'gone' as const

  constructor(
    providerId: string,
    message = 'Calendar sync cursor is no longer valid',
    options?: { cause?: unknown }
  ) {
    super(message, providerId, options)
    this.name = 'ProviderGoneError'
  }
}

/** The remote object changed under us (HTTP 412 / etag mismatch). */
export class ProviderConflictError extends ProviderError {
  readonly kind = 'conflict' as const

  constructor(
    providerId: string,
    message = 'Calendar event changed remotely',
    options?: { cause?: unknown }
  ) {
    super(message, providerId, options)
    this.name = 'ProviderConflictError'
  }
}

/** Throttled. The runner waits `retryAfterMs` before the next attempt. */
export class ProviderRateLimitError extends ProviderError {
  readonly kind = 'rate_limit' as const

  constructor(
    providerId: string,
    readonly retryAfterMs: number,
    message = 'Calendar provider rate limit reached',
    options?: { cause?: unknown }
  ) {
    super(message, providerId, options)
    this.name = 'ProviderRateLimitError'
  }
}

/** Network failure, timeout or 5xx. Safe to retry on the next pass. */
export class ProviderTransientError extends ProviderError {
  readonly kind = 'transient' as const

  constructor(
    providerId: string,
    message = 'Calendar provider is temporarily unreachable',
    options?: { cause?: unknown }
  ) {
    super(message, providerId, options)
    this.name = 'ProviderTransientError'
  }
}

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError
}

function statusOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('status' in error)) return null
  const status = (error as { status: unknown }).status
  return typeof status === 'number' ? status : null
}

function codeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null
  const code = (error as { code: unknown }).code
  return typeof code === 'string' ? code : null
}

/**
 * Map any error an adapter or legacy module throws onto the taxonomy. Returns
 * null for errors that are not provider failures (programming errors, DB
 * errors), which must keep propagating as they are.
 *
 * - HTTP status: 401/403 → auth, 410 → gone, 412 → conflict, 429 → rate limit, 5xx → transient
 * - `IcsFeedError` codes: `unauthorized` → auth, `unreachable`/`timeout` → transient
 */
export function classifyProviderError(providerId: string, error: unknown): ProviderError | null {
  if (error instanceof ProviderError) return error
  const message = error instanceof Error ? error.message : undefined
  const status = statusOf(error)
  if (status !== null) {
    if (status === 401 || status === 403) {
      return new ProviderAuthError(providerId, message, { cause: error, status })
    }
    if (status === 410) return new ProviderGoneError(providerId, message, { cause: error })
    if (status === 412) return new ProviderConflictError(providerId, message, { cause: error })
    if (status === 429) {
      const retryAfter =
        typeof error === 'object' && error !== null && 'retryAfterMs' in error
          ? Number((error as { retryAfterMs: unknown }).retryAfterMs)
          : NaN
      return new ProviderRateLimitError(
        providerId,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60_000,
        message,
        { cause: error }
      )
    }
    if (status >= 500) return new ProviderTransientError(providerId, message, { cause: error })
  }

  if (error instanceof Error && error.name === 'IcsFeedError') {
    const code = codeOf(error)
    if (code === 'unauthorized') return new ProviderAuthError(providerId, message, { cause: error })
    if (code === 'unreachable' || code === 'timeout') {
      return new ProviderTransientError(providerId, message, { cause: error })
    }
  }
  return null
}
