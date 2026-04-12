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

