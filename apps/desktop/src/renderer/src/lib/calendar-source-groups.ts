import { GOOGLE_CALENDAR_PROVIDER } from '@memry/contracts/calendar-api'
import type { CalendarSourceRecord } from '@/services/calendar-service'

export interface CalendarSourceGroup {
  provider: string
  sources: CalendarSourceRecord[]
}

/**
 * Imported calendars grouped by provider for the calendar page filter (#1395).
 * Google comes first, then providers in the order their calendars appear, so
 * a Google-only install sees exactly the one list it always had.
 */
export function groupSourcesByProvider(sources: CalendarSourceRecord[]): CalendarSourceGroup[] {
  const groups = new Map<string, CalendarSourceRecord[]>()
  for (const source of sources) {
    const list = groups.get(source.provider) ?? []
    list.push(source)
    groups.set(source.provider, list)
  }
  return [...groups.entries()]
    .map(([provider, list]) => ({ provider, sources: list }))
    .sort((left, right) => {
      if (left.provider === right.provider) return 0
      if (left.provider === GOOGLE_CALENDAR_PROVIDER) return -1
      if (right.provider === GOOGLE_CALENDAR_PROVIDER) return 1
      return 0
    })
}
