import type { Priority } from '@/data/task-model'

/** Search-result numbers are 0–4, none through urgent. */
export const PRIORITY_BY_NUMBER: readonly Priority[] = ['none', 'low', 'medium', 'high', 'urgent']

export function priorityFor(value: number): Priority {
  return PRIORITY_BY_NUMBER[value] ?? 'none'
}

function localDate(isoDay: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDay)
  if (!match) return null
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

function capitalize(text: string): string {
  return text.charAt(0).toLocaleUpperCase() + text.slice(1)
}

/** "Today", "Tomorrow", a weekday this week, else "Jul 21". */
export function dayLabel(isoDay: string, locale: string, now = new Date()): string {
  const day = localDate(isoDay)
  if (!day) return isoDay
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const diff = Math.round((day.getTime() - today.getTime()) / 86_400_000)
  if (diff >= -1 && diff <= 1) {
    return capitalize(new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(diff, 'day'))
  }
  if (diff > 1 && diff < 7) {
    return new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(day)
  }
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    ...(day.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {})
  }).format(day)
}

export function isPastDay(isoDay: string, now = new Date()): boolean {
  const day = localDate(isoDay)
  return day !== null && day < new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** Folder segments of a vault-relative path, without the file name. */
export function folderSegments(path: string): string[] {
  return path.split('/').filter(Boolean).slice(0, -1)
}
