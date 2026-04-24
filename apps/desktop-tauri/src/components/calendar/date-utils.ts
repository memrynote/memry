function pad(value: number): string {
  return String(value).padStart(2, '0')
}

export function toLocalDateString(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function toLocalDateKey(value: string): string {
  return toLocalDateString(new Date(value))
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

export function getStartOfWeek(value: string): string {
  const date = parseLocalDate(value)
  date.setDate(date.getDate() - date.getDay())
  return toLocalDateString(date)
}

export function getWeekNumber(value: string): number {
  const date = parseLocalDate(value)
  const startOfYear = new Date(date.getFullYear(), 0, 1)
  const daysSinceStart = Math.floor((date.getTime() - startOfYear.getTime()) / 86400000)
  return Math.ceil((daysSinceStart + startOfYear.getDay() + 1) / 7)
}

export function getMonthGridDays(anchorDate: string): string[] {
  const anchor = parseLocalDate(anchorDate)
  const year = anchor.getFullYear()
  const month = anchor.getMonth()
  const firstDay = new Date(year, month, 1)
  const leadingDays = firstDay.getDay()
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

export function getMonthGridDaysMondayStart(anchorDate: string): string[] {
  const anchor = parseLocalDate(anchorDate)
  const year = anchor.getFullYear()
  const month = anchor.getMonth()
  const firstDay = new Date(year, month, 1)
  const leadingDays = (firstDay.getDay() + 6) % 7
  const TOTAL_CELLS = 42
  return Array.from({ length: TOTAL_CELLS }, (_, i) => {
    const d = new Date(year, month, 1 - leadingDays + i)
    return toLocalDateString(d)
  })
}
