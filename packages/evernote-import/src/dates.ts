/**
 * Evernote date helpers.
 *
 * Evernote stores dates as "YYYYMMDDTHHMMSSZ" (always UTC, always Z-suffixed).
 * We convert to standard ISO 8601 format understood by the rest of the app.
 */

const ENEX_DATE_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/

/**
 * Parse an Evernote date string like "20231015T143022Z" to ISO 8601.
 * Returns undefined for null/empty/malformed input.
 */
export function parseEnexDate(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined
  const m = raw.trim().match(ENEX_DATE_RE)
  if (!m) return undefined
  const [, year, month, day, hour, min, sec] = m
  return `${year}-${month}-${day}T${hour}:${min}:${sec}Z`
}
