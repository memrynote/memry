import { getI18n } from 'react-i18next'
import { getActiveLocale } from '@/lib/active-locale'
import { formatDate } from '@/lib/format-date'

export type DueRelative = 'today' | 'tomorrow' | 'this-week' | 'absolute'

export interface FormatTaskDueInput {
  dueDate: string
  dueTime?: string | null
  endAt?: string | null
  completedAt?: string | null
  now?: Date
}

export interface FormatTaskDueResult {
  relative: DueRelative
  label: string
  isOverdue: boolean
}

export function formatTaskDue(input: FormatTaskDueInput): FormatTaskDueResult {
  const t = getI18n().getFixedT(null, 'common')
  const now = input.now ?? new Date()
  const due = parseDateOnly(input.dueDate)
  const today = startOfDay(now)
  const dayDelta = diffInCalendarDays(due, today)

  const completed = !!input.completedAt
  const isOverdue = dayDelta < 0 && !completed

  if (isOverdue) {
    const days = Math.abs(dayDelta)
    return {
      relative: 'absolute',
      label: t('dateRelative.daysOverdue', { count: days }),
      isOverdue: true
    }
  }

  const relative: DueRelative =
    dayDelta === 0
      ? 'today'
      : dayDelta === 1
        ? 'tomorrow'
        : dayDelta > 1 && dayDelta <= 6
          ? 'this-week'
          : 'absolute'

  const datePart =
    relative === 'today'
      ? t('dateRelative.today')
      : relative === 'tomorrow'
        ? t('dateRelative.tomorrow')
        : relative === 'this-week'
          ? weekdayShort(due)
          : absoluteDate(due)

  if (!input.dueTime) {
    return { relative, label: datePart, isOverdue: false }
  }

  const startLabel = formatTime(input.dueTime)
  if (input.endAt) {
    const endLabel = formatTimeFromIso(input.endAt)
    return { relative, label: `${datePart} · ${startLabel} – ${endLabel}`, isOverdue: false }
  }
  return { relative, label: `${datePart} · ${startLabel}`, isOverdue: false }
}

function parseDateOnly(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function diffInCalendarDays(a: Date, b: Date): number {
  return Math.round((startOfDay(a).getTime() - startOfDay(b).getTime()) / 86_400_000)
}

function weekdayShort(d: Date): string {
  return d.toLocaleDateString(getActiveLocale(), { weekday: 'short' })
}

function absoluteDate(d: Date): string {
  return formatDate(d)
}

function formatTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number)
  const date = new Date()
  date.setHours(h, m, 0, 0)
  return date.toLocaleTimeString(getActiveLocale(), { hour: 'numeric', minute: '2-digit' })
}

function formatTimeFromIso(iso: string): string {
  return new Date(iso).toLocaleTimeString(getActiveLocale(), { hour: 'numeric', minute: '2-digit' })
}
