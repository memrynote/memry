// Import-free so filter-date-compare.test.ts can load it in a child `node` with a real TZ.

/**
 * Compare two date values.
 */
export function compareDates(actual: unknown, expected: unknown): number {
  const days = compareCalendarDays(actual, expected)
  if (days !== null) return days

  const dateActual = toDate(actual)
  const dateExpected = toDate(expected)

  if (!dateActual || !dateExpected) return 0

  return dateActual.getTime() - dateExpected.getTime()
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T/

/**
 * A date-only value (`2026-10-07`) names a calendar day. Saved filters from builds
 * before BBF-74 hold the picked day as local midnight in ISO form. When either side
 * is date-only, compare both as local days so a non-UTC zone does not shift the day.
 * Returns null when neither side is date-only or a side is not a date value, so
 * free text such as `Oct 7 2026` keeps comparing as text.
 */
export function compareCalendarDays(actual: unknown, expected: unknown): number | null {
  if (!isDateOnly(actual) && !isDateOnly(expected)) return null
  if (!isDateValue(actual) || !isDateValue(expected)) return null
  const dayActual = toLocalDay(actual)
  const dayExpected = toLocalDay(expected)
  if (!dayActual || !dayExpected) return null
  return dayActual.localeCompare(dayExpected)
}

function isDateOnly(value: unknown): value is string {
  return typeof value === 'string' && DATE_ONLY.test(value)
}

function isDateValue(value: unknown): boolean {
  if (typeof value === 'string') return isDateOnly(value) || ISO_DATE_TIME.test(value)
  return value instanceof Date || typeof value === 'number'
}

function toLocalDay(value: unknown): string | null {
  if (isDateOnly(value)) return value
  const date = toDate(value)
  return date ? toPlainDay(date) : null
}

/** The local calendar day of `date` as `YYYY-MM-DD`, the shape the date picker stores. */
export function toPlainDay(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** A stored filter date as a local Date: a plain day, or a legacy ISO instant. */
export function parseFilterDay(value: unknown): Date | undefined {
  if (isDateOnly(value)) {
    const [year, month, day] = value.split('-').map(Number)
    return new Date(year, month - 1, day)
  }
  return toDate(value) ?? undefined
}

/**
 * Convert value to Date, returning null if not possible.
 */
function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value)
    return isNaN(date.getTime()) ? null : date
  }
  return null
}
