const MONTH_NAMES: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12
}

// Matches optional "Weekday, " prefix then "D Month YYYY".
// Weekday is length-bounded so the optional prefix cannot backtrack
// quadratically over long digit runs (ReDoS hardening).
const DATE_RE = /(?:\w{1,20},\s+)?(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/

/**
 * Parse an Apple Journal date header like "Sunday, 3 November 2024" into an ISO date.
 * Returns null if the text cannot be parsed.
 */
export function parseJournalDate(text: string): { iso: string } | null {
  const m = text.trim().match(DATE_RE)
  if (!m) return null

  const day = parseInt(m[1], 10)
  const month = MONTH_NAMES[m[2].toLowerCase()]
  const year = parseInt(m[3], 10)

  if (!month || day < 1 || day > 31 || year < 1900 || year > 2100) return null

  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  return { iso }
}
