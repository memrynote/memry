export interface SnoozeTarget {
  dueDate: string
  dueTime: string | null
}

export interface SnoozeOptionsInput {
  now: Date
  isAllDay: boolean
}

export interface SnoozeOptions {
  laterToday: SnoozeTarget | null
  tomorrow: SnoozeTarget
  nextWeek: SnoozeTarget
}

const HOUR = 60 * 60 * 1000

export function computeSnoozeOptions(input: SnoozeOptionsInput): SnoozeOptions {
  const { now, isAllDay } = input

  const laterToday = isAllDay ? null : computeLaterToday(now)
  const tomorrow: SnoozeTarget = {
    dueDate: ymd(addDays(startOfDay(now), 1)),
    dueTime: isAllDay ? null : '09:00'
  }
  const nextWeek: SnoozeTarget = {
    dueDate: ymd(nextMonday(now)),
    dueTime: isAllDay ? null : '09:00'
  }
  return { laterToday, tomorrow, nextWeek }
}

function computeLaterToday(now: Date): SnoozeTarget | null {
  if (now.getHours() >= 19) return null
  const target = new Date(now.getTime() + 3 * HOUR)
  const minTime = new Date(now.getTime() + HOUR)
  const cap = new Date(now)
  cap.setHours(20, 0, 0, 0)
  const final = target < minTime ? minTime : target > cap ? cap : target
  return {
    dueDate: ymd(final),
    dueTime: `${pad2(final.getHours())}:${pad2(final.getMinutes())}`
  }
}

function nextMonday(from: Date): Date {
  const d = startOfDay(from)
  const day = d.getDay()
  const delta = day === 0 ? 1 : 8 - day
  return addDays(d, delta)
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0')
}
