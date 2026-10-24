import type { CalendarProjectionVisualType } from '@/services/calendar-service'

import { spanDateKeys } from './date-utils'

export interface DaySummary {
  notes: number
  journal: number
  tasks: number
  events: number
  reminders: number
}

export interface DaySummaryInput {
  visualType: CalendarProjectionVisualType
  startAt: string
  endAt?: string | null
  isAllDay?: boolean
}

function emptySummary(): DaySummary {
  return { notes: 0, journal: 0, tasks: 0, events: 0, reminders: 0 }
}

export function daySummaryTotal(summary: DaySummary): number {
  return summary.notes + summary.journal + summary.tasks + summary.events + summary.reminders
}

/**
 * Rolls up per-day counts for the day-cell hover summary. Projection items are
 * bucketed by local day; journal is 0/1 derived from the heatmap activity level
 * (one journal entry per day). Days with no items are omitted.
 */
export function buildDaySummaries(
  items: readonly DaySummaryInput[],
  journalActivity: Record<string, number>
) {
  const result: Record<string, DaySummary> = {}
  const ensure = (key: string): DaySummary => (result[key] ??= emptySummary())

  // A multi-day item counts on every day it covers, not just its start day.
  for (const item of items) {
    for (const dayKey of spanDateKeys(item)) {
      const summary = ensure(dayKey)
      switch (item.visualType) {
        case 'note':
          summary.notes += 1
          break
        case 'task':
          summary.tasks += 1
          break
        case 'event':
        case 'external_event':
          summary.events += 1
          break
        case 'reminder':
        case 'snooze':
        case 'note_date':
          summary.reminders += 1
          break
      }
    }
  }

  for (const [key, level] of Object.entries(journalActivity)) {
    if (level > 0) ensure(key).journal = 1
  }

  for (const key of Object.keys(result)) {
    if (daySummaryTotal(result[key]) === 0) delete result[key]
  }

  return result
}
