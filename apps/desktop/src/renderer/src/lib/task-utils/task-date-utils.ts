// ============================================================================
// DATE HELPERS
// ============================================================================

export const startOfDay = (date: Date): Date => {
  const result = new Date(date)
  result.setHours(0, 0, 0, 0)
  return result
}

export const addDays = (date: Date, days: number): Date => {
  const result = new Date(date)
  result.setDate(result.getDate() + days)
  return result
}

export const subDays = (date: Date, days: number): Date => {
  return addDays(date, -days)
}

export const isSameDay = (date1: Date, date2: Date): boolean => {
  return (
    date1.getFullYear() === date2.getFullYear() &&
    date1.getMonth() === date2.getMonth() &&
    date1.getDate() === date2.getDate()
  )
}

export const isWithinInterval = (date: Date, range: { start: Date; end: Date }): boolean => {
  const time = date.getTime()
  return time >= range.start.getTime() && time <= range.end.getTime()
}

export const isBefore = (date1: Date, date2: Date): boolean => {
  return date1.getTime() < date2.getTime()
}

export const isAfter = (date1: Date, date2: Date): boolean => {
  return date1.getTime() > date2.getTime()
}

export const differenceInDays = (date1: Date, date2: Date): number => {
  const diffTime = date1.getTime() - date2.getTime()
  return Math.floor(diffTime / (1000 * 60 * 60 * 24))
}

export const nextSaturday = (from: Date = new Date()): Date => {
  const today = startOfDay(from)
  const currentDay = today.getDay()

  if (currentDay === 6) {
    return today
  }

  if (currentDay === 0) {
    return addDays(today, 6)
  }

  const daysUntilSaturday = 6 - currentDay
  return addDays(today, daysUntilSaturday)
}

export const nextMonday = (from: Date = new Date()): Date => {
  const today = startOfDay(from)
  const currentDay = today.getDay()

  if (currentDay === 1) {
    return addDays(today, 7)
  }

  const daysUntilMonday = currentDay === 0 ? 1 : 8 - currentDay
  return addDays(today, daysUntilMonday)
}

export const addWeeks = (date: Date, weeks: number): Date => {
  return addDays(date, weeks * 7)
}

export const addMonths = (date: Date, months: number): Date => {
  const result = new Date(date)
  result.setMonth(result.getMonth() + months)
  return result
}

export const subMonths = (date: Date, months: number): Date => {
  return addMonths(date, -months)
}

export const startOfMonth = (date: Date): Date => {
  const result = new Date(date)
  result.setDate(1)
  return startOfDay(result)
}

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

export const endOfWeek = (date: Date, weekStartsOn: 0 | 1 = 0): Date => {
  return addDays(startOfWeek(date, weekStartsOn), 6)
}

export const isSameMonth = (date1: Date, date2: Date): boolean => {
  return date1.getFullYear() === date2.getFullYear() && date1.getMonth() === date2.getMonth()
}

export const endOfDay = (date: Date): Date => {
  const result = new Date(date)
  result.setHours(23, 59, 59, 999)
  return result
}

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
