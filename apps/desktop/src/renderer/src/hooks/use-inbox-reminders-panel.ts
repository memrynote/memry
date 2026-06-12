import { useMemo } from 'react'

import { buildReminderPanel, type ReminderPanel } from '@/lib/reminder-panel'
import { useReminders } from './use-reminders'
import { useInboxList, useInboxSnoozed } from './use-inbox'

const UPCOMING_STATUSES = ['pending', 'snoozed'] as const

export interface InboxRemindersPanel extends ReminderPanel {
  upcomingCount: number
  isLoading: boolean
}

/**
 * Aggregates everything that should appear behind the inbox alarm icon:
 * scheduled reminders (pending/snoozed) and snoozed inbox items as Upcoming,
 * already-fired reminder inbox items as Past.
 *
 * All merge/sort/dedupe logic lives in `buildReminderPanel`; this hook only
 * wires the existing data sources to it. `useInboxList()` reuses the same query
 * cache as the inbox list, so it does not trigger an extra fetch.
 */
export function useInboxRemindersPanel(): InboxRemindersPanel {
  const { reminders, isLoading } = useReminders({
    status: [...UPCOMING_STATUSES],
    limit: 200
  })
  const { data: snoozedItems = [] } = useInboxSnoozed()
  const { items } = useInboxList()

  const panel = useMemo(
    () =>
      buildReminderPanel({
        reminders,
        snoozedItems,
        reminderItems: items
      }),
    [reminders, snoozedItems, items]
  )

  return {
    ...panel,
    upcomingCount: panel.upcoming.length,
    isLoading
  }
}
