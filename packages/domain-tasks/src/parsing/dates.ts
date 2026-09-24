/**
 * Local-calendar date helpers for the task parsing and recurrence logic.
 *
 * Every function works on the process's local calendar (what `Date` getters
 * return), exactly as the renderer's `task-date-utils` always has. None of them
 * reads the clock: a caller that needs "today" passes it in.
 */

export const startOfDay = (date: Date): Date => {
  const result = new Date(date)
  result.setHours(0, 0, 0, 0)
  return result
}

export const endOfDay = (date: Date): Date => {
  const result = new Date(date)
  result.setHours(23, 59, 59, 999)
  return result
}

export const addDays = (date: Date, days: number): Date => {
  const result = new Date(date)
  result.setDate(result.getDate() + days)
  return result
}

export const subDays = (date: Date, days: number): Date => addDays(date, -days)

export const addWeeks = (date: Date, weeks: number): Date => addDays(date, weeks * 7)

export const addMonths = (date: Date, months: number): Date => {
  const result = new Date(date)
  result.setMonth(result.getMonth() + months)
  return result
}

export const addYears = (date: Date, years: number): Date => {
  const result = new Date(date)
  result.setFullYear(result.getFullYear() + years)
  return result
}

export const isSameDay = (date1: Date, date2: Date): boolean =>
  date1.getFullYear() === date2.getFullYear() &&
  date1.getMonth() === date2.getMonth() &&
  date1.getDate() === date2.getDate()

export const isWithinInterval = (date: Date, range: { start: Date; end: Date }): boolean => {
  const time = date.getTime()
  return time >= range.start.getTime() && time <= range.end.getTime()
}

export const isBefore = (date1: Date, date2: Date): boolean => date1.getTime() < date2.getTime()

export const isAfter = (date1: Date, date2: Date): boolean => date1.getTime() > date2.getTime()

export const endOfMonth = (date: Date): Date => {
  const result = new Date(date)
  result.setMonth(result.getMonth() + 1)
  result.setDate(0)
  return startOfDay(result)
}

export const startOfWeek = (date: Date, weekStartsOn: 0 | 1 = 0): Date => {
  const result = startOfDay(date)
  const day = result.getDay()
  const diff = (day < weekStartsOn ? 7 : 0) + day - weekStartsOn
  return subDays(result, diff)
}

export const endOfWeek = (date: Date, weekStartsOn: 0 | 1 = 0): Date =>
  addDays(startOfWeek(date, weekStartsOn), 6)

export const formatDateKey = (date: Date): string => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export const parseDateKey = (key: string): Date => {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year, month - 1, day)
}

/** The Monday after `from` (a Monday itself moves a full week). */
export const nextMonday = (from: Date): Date => {
  const today = startOfDay(from)
  const currentDay = today.getDay()
  if (currentDay === 1) return addDays(today, 7)
  const daysUntilMonday = currentDay === 0 ? 1 : 8 - currentDay
  return addDays(today, daysUntilMonday)
}

/** The coming Saturday, or `from` itself when it is one. */
export const nextSaturday = (from: Date): Date => {
  const today = startOfDay(from)
  const currentDay = today.getDay()
  if (currentDay === 6) return today
  if (currentDay === 0) return addDays(today, 6)
  return addDays(today, 6 - currentDay)
}

/** Last week's Monday (for "last week"). */
export const lastMonday = (from: Date): Date => {
  const today = startOfDay(from)
  const currentDay = today.getDay()
  const sinceMonday = currentDay === 0 ? 6 : currentDay - 1
  const thisMonday = addDays(today, -sinceMonday)
  return addDays(thisMonday, -7)
}
