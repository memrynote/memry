// Import-free so filter-date-compare.test.ts can load it in a child `node` with a real TZ.

/**
 * Compare two date values.
 */
export function compareDates(actual: unknown, expected: unknown): number {
  const dateActual = toDate(actual)
  const dateExpected = toDate(expected)

  if (!dateActual || !dateExpected) return 0

  return dateActual.getTime() - dateExpected.getTime()
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
