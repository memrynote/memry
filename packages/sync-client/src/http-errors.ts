/**
 * Sync transport error taxonomy. Platform-free: raised by desktop's
 * http-client today and by any future shell's transport adapter; `retry.ts`
 * and `sync-errors` classify against these without importing a transport.
 */
export class SyncServerError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly serverError?: string
  ) {
    super(message)
    this.name = 'SyncServerError'
  }
}

/**
 * One file is over the plan's per-file limit. Raised by the local preflight
 * before a file is read/encrypted; mirrors the server's STORAGE_FILE_TOO_LARGE.
 * Lives here with the other sync error types so `sync-errors` can classify it
 * without importing the attachment service (and with it, electron + crypto).
 */
export class AttachmentTooLargeError extends Error {
  constructor(
    message: string,
    public readonly fileSize: number,
    public readonly maxFileSize: number
  ) {
    super(message)
    this.name = 'AttachmentTooLargeError'
  }
}

export class NetworkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NetworkError'
  }
}

const MAX_RETRY_AFTER_SECONDS = 300

export class RateLimitError extends SyncServerError {
  public readonly retryAfterMs: number

  constructor(public readonly retryAfter?: number) {
    super('Too many requests. Please try again later.', 429)
    this.name = 'RateLimitError'
    this.retryAfterMs = Math.min(retryAfter ?? 60, MAX_RETRY_AFTER_SECONDS) * 1000
  }
}

export function parseRetryAfterHeader(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (!Number.isNaN(seconds) && seconds >= 0) return seconds
  const date = new Date(header)
  if (!Number.isNaN(date.getTime())) {
    const deltaMs = date.getTime() - Date.now()
    return Math.max(0, Math.ceil(deltaMs / 1000))
  }
  return undefined
}
