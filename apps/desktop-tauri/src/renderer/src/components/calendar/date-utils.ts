function pad(value: number): string {
  return String(value).padStart(2, '0')
}

export function toLocalDateString(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function toLocalDateKey(value: string): string {
  return toLocalDateString(new Date(value))
}

/**
 * Minimal shape every calendar view shares: a projection item's local span.
 * `endAt` is exclusive for all-day items (projection stores next-day midnight)
 * and for timed items that land exactly on midnight.
 */
export interface DateSpanLike {
  startAt: string
  endAt?: string | null
  isAllDay?: boolean
}

// A span longer than this is almost certainly bad data; rendering a bar per day
// for it would stall the grid.
const MAX_SPAN_DAYS = 400

export function spanStartDateKey(item: DateSpanLike): string {
  return toLocalDateKey(item.startAt)
}

/** Last day the span actually covers, inclusive. */
export function spanEndDateKey(item: DateSpanLike): string {
  const startKey = spanStartDateKey(item)
  if (!item.endAt) return startKey
  const end = new Date(item.endAt)
  if (Number.isNaN(end.getTime())) return startKey
  const endsOnMidnight =
    end.getHours() === 0 &&
    end.getMinutes() === 0 &&
    end.getSeconds() === 0 &&
    end.getMilliseconds() === 0
  // Exclusive end: a span ending at midnight belongs to the previous day.
  const inclusiveEnd = item.isAllDay || endsOnMidnight ? new Date(end.getTime() - 1) : end
  const endKey = toLocalDateString(inclusiveEnd)
  return endKey < startKey ? startKey : endKey
}

export function spanDayCount(item: DateSpanLike): number {
  const days = dayIndexFromDate(spanEndDateKey(item)) - dayIndexFromDate(spanStartDateKey(item)) + 1
  return Math.min(Math.max(days, 1), MAX_SPAN_DAYS)
}

export function isMultiDaySpan(item: DateSpanLike): boolean {
  return spanDayCount(item) > 1
}

/** True when the span covers `date` (a `YYYY-MM-DD` local day key). */
export function spanCoversDate(item: DateSpanLike, date: string): boolean {
  return date >= spanStartDateKey(item) && date <= spanEndDateKey(item)
}

/** Every local day key the span covers, inclusive, start first. */
export function spanDateKeys(item: DateSpanLike): string[] {
  const start = spanStartDateKey(item)
  const count = spanDayCount(item)
  if (count === 1) return [start]
  return Array.from({ length: count }, (_, i) => addLocalDays(start, i))
}

export function parseLocalDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day, 0, 0, 0, 0)
}

export function addLocalDays(value: string, amount: number): string {
  const date = parseLocalDate(value)
  date.setDate(date.getDate() + amount)
  return toLocalDateString(date)
}

export function addLocalMonths(value: string, amount: number): string {
  const date = parseLocalDate(value)
  date.setMonth(date.getMonth() + amount)
  return toLocalDateString(date)
}

export function addLocalYears(value: string, amount: number): string {
  const date = parseLocalDate(value)
  date.setFullYear(date.getFullYear() + amount)
  return toLocalDateString(date)
}

export function toStartOfLocalDayIso(value: string): string {
  return parseLocalDate(value).toISOString()
}

export function toLocalDateInputValue(value: string): string {
  return toLocalDateString(new Date(value))
}

export function toLocalDateTimeInputValue(value: string): string {
  const date = new Date(value)
  return `${toLocalDateString(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function localInputToIso(value: string, isAllDay: boolean): string {
  const normalized = isAllDay ? `${value}T00:00:00` : value
  const date = new Date(normalized)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid calendar input datetime: ${value}`)
  }
  return date.toISOString()
}

export function getStartOfWeek(value: string, weekStartsOn: 0 | 1 = 0): string {
  const date = parseLocalDate(value)
  const diff = (date.getDay() - weekStartsOn + 7) % 7
  date.setDate(date.getDate() - diff)
  return toLocalDateString(date)
}

// Weekday header labels rotated to the given week start. June 7 2020 is a
// Sunday, so `7 + weekStartsOn` picks the first column's weekday.
export function getWeekdayLabels(
  locale: string,
  weekStartsOn: 0 | 1,
  weekday: 'short' | 'narrow' = 'short'
): string[] {
  const formatter = new Intl.DateTimeFormat(locale, { weekday })
  return Array.from({ length: 7 }, (_, i) =>
    formatter.format(new Date(2020, 5, 7 + weekStartsOn + i))
  )
}

export function getWeekNumber(value: string): number {
  const date = parseLocalDate(value)
  const startOfYear = new Date(date.getFullYear(), 0, 1)
  const daysSinceStart = Math.floor((date.getTime() - startOfYear.getTime()) / 86400000)
  return Math.ceil((daysSinceStart + startOfYear.getDay() + 1) / 7)
}

export function getMonthGridDays(anchorDate: string, weekStartsOn: 0 | 1 = 0): string[] {
  const anchor = parseLocalDate(anchorDate)
  const year = anchor.getFullYear()
  const month = anchor.getMonth()
  const firstDay = new Date(year, month, 1)
  const leadingDays = (firstDay.getDay() - weekStartsOn + 7) % 7
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const totalCells = Math.ceil((leadingDays + daysInMonth) / 7) * 7
  return Array.from({ length: totalCells }, (_, i) => {
    const d = new Date(year, month, 1 - leadingDays + i)
    return toLocalDateString(d)
  })
}

export function isToday(value: string): boolean {
  return value === toLocalDateString(new Date())
}

export function isSameMonth(dateStr: string, anchorDate: string): boolean {
  return dateStr.slice(0, 7) === anchorDate.slice(0, 7)
}

const DAY_INDEX_EPOCH = '2020-01-01'
const MS_PER_DAY = 86_400_000

export function dayIndexFromDate(value: string): number {
  const date = parseLocalDate(value)
  const epoch = parseLocalDate(DAY_INDEX_EPOCH)
  const dateMs = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
  const epochMs = Date.UTC(epoch.getFullYear(), epoch.getMonth(), epoch.getDate())
  return Math.round((dateMs - epochMs) / MS_PER_DAY)
}

export function dateFromDayIndex(index: number): string {
  const epoch = parseLocalDate(DAY_INDEX_EPOCH)
  const utc = new Date(Date.UTC(epoch.getFullYear(), epoch.getMonth(), epoch.getDate()))
  utc.setUTCDate(utc.getUTCDate() + index)
  return `${utc.getUTCFullYear()}-${pad(utc.getUTCMonth() + 1)}-${pad(utc.getUTCDate())}`
}

export function isWeekend(date: string): boolean {
  const d = parseLocalDate(date).getDay()
  return d === 0 || d === 6
}

// Fixed 42-cell (6-row) grid so year-view mini-months stay uniform.
export function getMonthGridDaysFixed(anchorDate: string, weekStartsOn: 0 | 1 = 1): string[] {
  const anchor = parseLocalDate(anchorDate)
  const year = anchor.getFullYear()
  const month = anchor.getMonth()
  const firstDay = new Date(year, month, 1)
  const leadingDays = (firstDay.getDay() - weekStartsOn + 7) % 7
  const TOTAL_CELLS = 42
  return Array.from({ length: TOTAL_CELLS }, (_, i) => {
    const d = new Date(year, month, 1 - leadingDays + i)
    return toLocalDateString(d)
  })
}
