import type { CalendarWorkspaceView } from './calendar-toolbar'
import { addLocalDays, getStartOfWeek, parseLocalDate } from './date-utils'

export function getSubLabel(
  view: CalendarWorkspaceView,
  anchorDate: string,
  locale?: string
): string {
  const date = parseLocalDate(anchorDate)

  if (view === 'day') {
    return new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(date)
  }

  if (view === 'week') {
    const start = parseLocalDate(getStartOfWeek(anchorDate))
    const end = parseLocalDate(addLocalDays(getStartOfWeek(anchorDate), 6))
    const fmt = new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    })
    return `${fmt.format(start)} – ${fmt.format(end)}`
  }

  if (view === 'month') {
    const first = new Date(date.getFullYear(), date.getMonth(), 1)
    const last = new Date(date.getFullYear(), date.getMonth() + 1, 0)
    const fmt = new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    })
    return `${fmt.format(first)} – ${fmt.format(last)}`
  }

  return String(date.getFullYear())
}
