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

/**
 * A date-only value (`2026-10-07`) names a calendar day, while the filter's date
 * picker stores the picked day as local midnight in ISO form. When either side is
 * date-only, compare both as local days so a non-UTC zone does not shift the day.
 * Returns null when neither side is date-only or a side is not a date.
 */
export function compareCalendarDays(actual: unknown, expected: unknown): number | null {
  if (!isDateOnly(actual) && !isDateOnly(expected)) return null
  const dayActual = toLocalDay(actual)
  const dayExpected = toLocalDay(expected)
  if (!dayActual || !dayExpected) return null
  return dayActual.localeCompare(dayExpected)
}

function isDateOnly(value: unknown): value is string {
  return typeof value === 'string' && DATE_ONLY.test(value)
}

function toLocalDay(value: unknown): string | null {
  if (isDateOnly(value)) return value
  const date = toDate(value)
  if (!date) return null
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
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
