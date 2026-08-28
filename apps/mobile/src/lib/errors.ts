/**
 * Carries the HTTP status and the server's error code so callers can act on
 * them. Without this a screen can only pattern-match the message, and an
 * expired session reads to the user as a mysterious failure instead of a trip
 * back to sign-in.
 *
 * `message` is the raw wire text and belongs in logs, never on screen. The
 * humanising lives in `extractErrorMessage` below so that no caller has to
 * remember the distinction.
 */
export class SyncRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null
  ) {
    super(message)
    this.name = 'SyncRequestError'
  }
}

/**
 * Server error codes that mean exactly one thing to a person, whatever the
 * request was. A table rather than a chain of conditions, because the set only
 * ever grows and every entry is the same shape.
 *
 * Deliberately absent: `VALIDATION_ERROR`. It says a field was wrong but not
 * which one, so the caller's fallback — written where the field is known — is
 * the better sentence.
 */
const CODE_MESSAGES: Record<string, string> = {
  AUTH_INVALID_OTP: 'That code is not right. Check it and try again.',
  AUTH_OTP_EXPIRED: 'That code has expired. Ask for a new one.',
  AUTH_OTP_MAX_ATTEMPTS: 'Too many tries with that code. Ask for a new one.',
  RATE_LIMITED: 'Too many attempts. Wait a minute and try again.',
  AUTH_RATE_LIMITED: 'Too many attempts. Wait a minute and try again.',
  AUTH_INVALID_TOKEN: 'Your session has expired. Sign in again.',
  AUTH_TOKEN_EXPIRED: 'Your session has expired. Sign in again.',
  AUTH_DEVICE_REVOKED: 'This device was removed from your account. Sign in again.',
  AUTH_DEVICE_NOT_FOUND: 'This device is no longer registered. Sign in again.',
  AUTH_INVALID_PROVIDER: 'That sign-in method is not available.',
  SYNC_PAYMENT_REQUIRED: 'Your plan does not include sync. Check your subscription.',
  SYNC_VAULT_NOT_FOUND: 'That vault is no longer on your account.'
}

const STATUS_MESSAGES: Record<number, string> = {
  500: 'Something went wrong on our side. Try again in a moment.',
  502: 'Memry is unreachable right now. Try again in a moment.',
  503: 'Memry is unreachable right now. Try again in a moment.',
  504: 'Memry is unreachable right now. Try again in a moment.'
}

/**
 * User-facing error text — the mobile twin of desktop's `extractErrorMessage`
 * from `@/lib/ipc-error` (same contract: never show a raw stack, always fall
 * back to the caller's plain-language message).
 *
 * A `SyncRequestError` never reaches the screen with its own message. Its text
 * is wire protocol ("/auth/otp/verify failed (HTTP 401): AUTH_INVALID_OTP"),
 * and letting it through is how that string ended up in front of a user. Every
 * other error keeps its message, because those are thrown by this codebase and
 * are written for people.
 */
export function extractErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof SyncRequestError) {
    if (err.code && CODE_MESSAGES[err.code]) return CODE_MESSAGES[err.code]
    return STATUS_MESSAGES[err.status] ?? fallback
  }
  if (err instanceof Error && err.message.trim().length > 0) return err.message
  if (typeof err === 'string' && err.trim().length > 0) return err
  return fallback
}
