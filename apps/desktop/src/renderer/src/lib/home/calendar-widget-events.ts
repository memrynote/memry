import type { CalendarProjectionItem } from '@/services/calendar-service'
import { getEventBaseColor } from '@/lib/event-type-colors'
import { formatTimeOfDay, type ClockFormat } from '@/lib/time-format'

// A today's-schedule event shaped for the Home Calendar widget. Pure data — no React, no i18n,
// so the time math (sort, duration, now-line, next-up) is unit-testable. The component turns
// `durationMinutes`/the now/next indices into localized strings.
export interface CalendarWidgetEvent {
  id: string
  startAtMs: number
  startTimeLabel: string
  durationMinutes: number | null
  title: string
  color: string
  metaLabel: string | null
}

function capitalize(value: string): string {
  if (!value) return value
  return value[0].toUpperCase() + value.slice(1)
}

function formatSnoozeOffset(minutes: number): string {
  const sign = minutes >= 0 ? '+' : '-'
  const abs = Math.abs(minutes)
  if (abs < 60) return `${sign}${abs}m`
  const hours = Math.floor(abs / 60)
  const rem = abs % 60
  return rem === 0 ? `${sign}${hours}h` : `${sign}${hours}h${rem}m`
}

// Mirrors journal-day-panel's getScheduleLabel (kept local — that one is private to journal).
function getMetaLabel(item: CalendarProjectionItem): string | null {
  switch (item.visualType) {
    case 'external_event':
      return item.source.provider ? capitalize(item.source.provider) : null
    case 'reminder':
      return item.snoozeOffsetMinutes !== null ? formatSnoozeOffset(item.snoozeOffsetMinutes) : null
    case 'snooze':
      return 'inbox'
    default:
      return null
  }
}

function getDurationMinutes(item: CalendarProjectionItem): number | null {
  if (item.isAllDay || !item.endAt) return null
  const start = new Date(item.startAt).getTime()
  const end = new Date(item.endAt).getTime()
  const minutes = Math.round((end - start) / 60_000)
  return minutes > 0 ? minutes : null
}

export function toCalendarWidgetEvents(
  items: CalendarProjectionItem[],
  clockFormat: ClockFormat
): CalendarWidgetEvent[] {
  return items
    .filter((item) => item.visualType !== 'task')
    .map((item) => ({
      id: item.projectionId,
      startAtMs: new Date(item.startAt).getTime(),
      startTimeLabel: formatTimeOfDay(new Date(item.startAt), clockFormat),
      durationMinutes: getDurationMinutes(item),
      title: item.title,
      color: getEventBaseColor(item.visualType),
      metaLabel: getMetaLabel(item)
    }))
    .sort((a, b) => a.startAtMs - b.startAtMs)
}

// Index of the first event that has not started yet (the "next up" highlight). -1 when none.
export function findNextEventIndex(events: CalendarWidgetEvent[], nowMs: number): number {
  return events.findIndex((e) => e.startAtMs >= nowMs)
}

// Where the live "now" line sits among the sorted events: the count of events already started.
// 0 = before the first event, events.length = after the last.
export function nowLinePosition(events: CalendarWidgetEvent[], nowMs: number): number {
  return events.filter((e) => e.startAtMs <= nowMs).length
}
