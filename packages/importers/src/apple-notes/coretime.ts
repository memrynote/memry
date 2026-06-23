/**
 * Apple CoreData / CoreTime timestamps count seconds from the reference date
 * 2001-01-01T00:00:00Z. Adding this offset converts them to Unix epoch seconds.
 */
export const CORETIME_OFFSET = 978307200

/**
 * Convert an Apple CoreTime value (seconds since 2001-01-01) into an ISO 8601
 * string. Non-positive / missing values fall back to the Unix epoch start so
 * callers always get a valid date.
 */
export function coreTimeToIso(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return new Date(0).toISOString()
  }
  return new Date(Math.floor((seconds + CORETIME_OFFSET) * 1000)).toISOString()
}
