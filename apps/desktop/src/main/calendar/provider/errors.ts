/**
 * Provider-neutral calendar error taxonomy.
 *
 * Today the sync engine sniffs Google's wire shape directly (`status === 410`
 * for an invalidated syncToken, `status === 412` for an etag mismatch). Every
 * other protocol we are about to speak reports the same conditions differently
 * — CalDAV answers 412 on a stale ETag but 404/`valid-sync-token` on a dead
 * sync-collection token, Microsoft Graph hands back `resyncRequired` in a JSON
 * body. Adapters translate their own wire errors into these classes so the
 * engine can react to the *condition* rather than to one vendor's status code.
 */

export abstract class ProviderError extends Error {
  /** The provider that raised it, when the adapter knows its own id. */
  readonly providerId?: string

  constructor(message: string, options?: { providerId?: string; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = new.target.name
    this.providerId = options?.providerId
  }
}

/**
 * Credentials are gone or no longer accepted. Drives the `reconnect_required`
 * account status — the user has to re-authorize, retrying will not help.
 */
export class ProviderAuthError extends ProviderError {}

/**
 * The incremental cursor the provider gave us is no longer valid (Google 410,
 * CalDAV `valid-sync-token`, Graph `resyncRequired`). The engine clears
 * `sync_cursor` and re-runs the source from scratch.
 */
export class ProviderGoneError extends ProviderError {}

/** The remote copy moved under us — HTTP 412 / ETag mismatch. */
export class ProviderConflictError extends ProviderError {}

/** Throttled. `retryAfterMs` is the provider's own hint when it gave one. */
export class ProviderRateLimitError extends ProviderError {
  readonly retryAfterMs: number | null

  constructor(
    message: string,
    options?: { retryAfterMs?: number | null; providerId?: string; cause?: unknown }
  ) {
    super(message, options)
    this.retryAfterMs = options?.retryAfterMs ?? null
  }
}

/** Network blip, 5xx, timeout — worth retrying on the next pass, nothing to report. */
export class ProviderTransientError extends ProviderError {}
