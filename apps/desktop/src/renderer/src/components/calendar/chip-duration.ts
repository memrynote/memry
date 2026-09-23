import type { CalendarProjectionItem } from '@/services/calendar-service'

type Translate = (key: string, options?: Record<string, unknown>) => string

/** Minutes between a timed item's start and end, or null when it has no usable end. */
export function itemDurationMinutes(
  item: Pick<CalendarProjectionItem, 'startAt' | 'endAt' | 'isAllDay'>
): number | null {
  if (item.isAllDay || !item.endAt) return null
  const minutes = Math.round(
    (new Date(item.endAt).getTime() - new Date(item.startAt).getTime()) / 60_000
  )
  return Number.isFinite(minutes) && minutes > 0 ? minutes : null
}

/** `45m`, `2h`, `1h 30m` — the compact duration shown on chips and detail cards. */
export function formatDurationShort(minutes: number, t: Translate): string {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours === 0) return t('chip.duration-minutes', { minutes: rest })
  if (rest === 0) return t('chip.duration-hours', { hours })
  return t('chip.duration-hours-minutes', { hours, minutes: rest })
}
