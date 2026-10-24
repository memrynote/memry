import { groupItemsByTimePeriod, type GroupedItems, type TimePeriod } from '@/lib/inbox-utils'
import type { ProjectLinkedEvent, ProjectLinkedFile, ProjectLinkedNote } from '@memry/rpc/tasks'

/**
 * The hub lists notes, files and events with the Inbox's time sections. Notes
 * and files reuse the Inbox buckets verbatim (Today / Yesterday / Older) off
 * their last-modified stamp.
 *
 * Events cannot: they mostly point forward, and every future event would land
 * in "Older". They get their own forward-facing buckets instead, rendered with
 * the same section chrome.
 */
export type EventPeriod = 'TODAY' | 'TOMORROW' | 'UPCOMING' | 'PAST'

/** i18n key under `projectHub.groups` for a section label. */
export const periodLabelKey = (period: TimePeriod | EventPeriod): string =>
  `projectHub.groups.${period.toLowerCase()}`

const byModifiedAt = (item: ProjectLinkedNote | ProjectLinkedFile): Date =>
  new Date(item.modifiedAt)

export const groupNotesByModified = (
  notes: ProjectLinkedNote[]
): GroupedItems<ProjectLinkedNote>[] => groupItemsByTimePeriod(notes, byModifiedAt)

export const groupFilesByModified = (
  files: ProjectLinkedFile[]
): GroupedItems<ProjectLinkedFile>[] => groupItemsByTimePeriod(files, byModifiedAt)

export interface GroupedEvents {
  period: EventPeriod
  items: ProjectLinkedEvent[]
}

const startOfDay = (date: Date): Date => {
  const copy = new Date(date)
  copy.setHours(0, 0, 0, 0)
  return copy
}

/** `days` ahead of `from`, via setDate so a DST boundary does not shift the cut. */
const addDays = (from: Date, days: number): Date => {
  const copy = new Date(from)
  copy.setDate(copy.getDate() + days)
  return copy
}

const byStartAsc = (a: ProjectLinkedEvent, b: ProjectLinkedEvent): number =>
  new Date(a.startAt).getTime() - new Date(b.startAt).getTime()

export const groupEventsByStart = (
  events: ProjectLinkedEvent[],
  now: Date = new Date()
): GroupedEvents[] => {
  const today = startOfDay(now)
  const tomorrow = addDays(today, 1)
  const dayAfter = addDays(today, 2)

  const groups: Record<EventPeriod, ProjectLinkedEvent[]> = {
    TODAY: [],
    TOMORROW: [],
    UPCOMING: [],
    PAST: []
  }

  for (const event of events) {
    const start = new Date(event.startAt).getTime()
    if (start < today.getTime()) groups.PAST.push(event)
    else if (start < tomorrow.getTime()) groups.TODAY.push(event)
    else if (start < dayAfter.getTime()) groups.TOMORROW.push(event)
    else groups.UPCOMING.push(event)
  }

  // Soonest first while looking forward; most recent first when looking back.
  groups.TODAY.sort(byStartAsc)
  groups.TOMORROW.sort(byStartAsc)
  groups.UPCOMING.sort(byStartAsc)
  groups.PAST.sort((a, b) => byStartAsc(b, a))

  const order: EventPeriod[] = ['TODAY', 'TOMORROW', 'UPCOMING', 'PAST']
  return order
    .filter((period) => groups[period].length > 0)
    .map((period) => ({ period, items: groups[period] }))
}
