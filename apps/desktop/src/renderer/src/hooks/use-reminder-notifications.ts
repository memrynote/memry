/**
 * Reminder Notifications Hook
 *
 * Listens for reminder due events and shows in-app toast notifications
 * with snooze options. Also handles desktop notification click events.
 *
 * T232: In-app toast notification for due reminders
 * T233: Snooze options in notification
 *
 * @module hooks/use-reminder-notifications
 */

import { useEffect, useCallback } from 'react'
import { createLogger } from '@/lib/logger'
import { toast } from 'sonner'
import { useTabs } from '@/contexts/tabs'
import { useT } from '@memry/i18n/renderer'
import { useDismissReminder } from '@/hooks/use-reminders'
import { buildReminderTargetTab } from '@/lib/open-reminder-target'
import type { ReminderWithTarget } from '@/services/reminder-service'

const log = createLogger('Hook:ReminderNotifications')

// ============================================================================
// Types
// ============================================================================

interface ReminderDueEvent {
  reminders: ReminderWithTarget[]
  count: number
}

interface ReminderClickedEvent {
  reminder: ReminderWithTarget
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Hook that listens for reminder events and shows notifications.
 * Should be used once at the app level.
 */
export function useReminderNotifications(): void {
  const { openTab } = useTabs()
  const { t } = useT('common')
  // The reminder target fallbacks live in the inbox namespace, beside the other
  // reminder strings the detail panel and the reminder list already use.
  const { t: inboxT } = useT('inbox')
  const dismissMutation = useDismissReminder()

  // Navigate to reminder target.
  //
  // Deliberately the SAME builder the inbox reminder detail and the reminder
  // list use. This path used to carry its own switch, which opened a journal as
  // `path: '/journal?date=<date>'` with no `viewState` — the journal page reads
  // the day off `viewState.date` and ignores the query, and the singleton-tab
  // dedup matches on `path`, so clicking a due journal reminder focused the
  // open journal tab and left it on today (#2071). It also had no `task` case
  // at all, so a due task reminder's "View" did nothing.
  const navigateToTarget = useCallback(
    (reminder: ReminderWithTarget) => {
      const tab = buildReminderTargetTab({
        targetType: reminder.targetType,
        targetId: reminder.targetId,
        targetTitle: reminder.targetTitle,
        projectId: reminder.projectId ?? undefined,
        anchorId: reminder.anchorId ?? undefined,
        highlightStart: reminder.highlightStart ?? undefined,
        highlightEnd: reminder.highlightEnd ?? undefined,
        highlightText: reminder.highlightText ?? undefined,
        fallbacks: {
          note: inboxT('reminder.noteFallback'),
          journal: inboxT('reminder.journalFallback'),
          task: inboxT('reminder.taskFallback')
        }
      })

      // A journal reminder whose stored date is unusable has no day to open.
      // Say so rather than dropping the user on today's entry.
      if (!tab) {
        log.warn(`Reminder ${reminder.id} has an unusable target: ${reminder.targetId}`)
        toast.error(inboxT('reminder.dataUnavailable'))
        return
      }

      openTab(tab)
    },
    [openTab, inboxT]
  )

  // Show toast notification for a reminder
  const showReminderToast = useCallback(
    (reminder: ReminderWithTarget) => {
      const title = reminder.title || reminder.targetTitle || 'Reminder'

      // Build description
      let description = ''
      if (reminder.targetType === 'highlight' && reminder.highlightText) {
        description = `"${reminder.highlightText.slice(0, 80)}${reminder.highlightText.length > 80 ? '...' : ''}"`
      } else if (reminder.note) {
        description = reminder.note
      } else {
        const typeLabels: Record<string, string> = {
          note: 'Note reminder',
          journal: 'Journal reminder',
          highlight: 'Highlight reminder',
          note_date: 'Note reminder'
        }
        description = typeLabels[reminder.targetType] || 'Reminder due'
      }

      // Simple toast with View and Dismiss options
      toast(title, {
        description,
        duration: 10000,
        action: {
          label: 'View',
          onClick: () => navigateToTarget(reminder)
        },
        cancel: {
          label: 'Dismiss',
          onClick: () => dismissMutation.mutate(reminder.id)
        }
      })
    },
    [navigateToTarget, dismissMutation]
  )

  // Handle reminder due events
  useEffect(() => {
    const unsubscribeDue = window.api.onReminderDue((event: ReminderDueEvent) => {
      log.info(`${event.count} reminder(s) due`)

      // Show toast for each due reminder (limit to avoid toast spam)
      const remindersToShow = event.reminders.slice(0, 5)
      for (const reminder of remindersToShow) {
        showReminderToast(reminder)
      }

      // If there are more than 5, show a summary
      if (event.count > 5) {
        toast.info(t('toast.moreRemindersDue', { count: event.count - 5 }), {
          description: t('toast.moreRemindersDueHint')
        })
      }
    })

    return () => {
      unsubscribeDue()
    }
  }, [showReminderToast, t])

  // Handle desktop notification click events (navigate to target)
  useEffect(() => {
    const unsubscribeClicked = window.api.onReminderClicked((event: ReminderClickedEvent) => {
      log.info(`Desktop notification clicked for reminder ${event.reminder.id}`)
      navigateToTarget(event.reminder)
    })

    return () => {
      unsubscribeClicked()
    }
  }, [navigateToTarget])
}

export default useReminderNotifications
