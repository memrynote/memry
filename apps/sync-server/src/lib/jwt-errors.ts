/**
 * Classify a failed `jwtVerify` rejection as "the token expired".
 *
 * jose reports expiry as `JWTExpired` whose message is
 * `"exp" claim timestamp check failed` — the word "expired" never appears in
 * it. Call sites that sniffed the message therefore never matched, and every
 * expired token was reported to the client as *invalid* instead. That is how a
 * timed-out setup token reached users as "Invalid setup token" after a
 * reinstall (issue #1202): the five-minute setup token had simply run out
 * while they went looking for their recovery phrase.
 *
 * Match on jose's stable error code and keep the message check as a fallback
 * for anything else that throws its own expiry error.
 */
export const JWT_EXPIRED_ERROR_CODE = 'ERR_JWT_EXPIRED'

export function isJwtExpiredError(err: unknown): boolean {
  if (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === JWT_EXPIRED_ERROR_CODE
  ) {
    return true
  }

  const message = err instanceof Error ? err.message : ''
  return message.includes('expired') || message.includes('"exp" claim timestamp check failed')
}
