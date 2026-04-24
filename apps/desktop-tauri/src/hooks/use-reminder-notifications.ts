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
import { useDismissReminder } from '@/hooks/use-reminders'
import { subscribeEvent } from '@/lib/ipc/forwarder'
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
  const dismissMutation = useDismissReminder()

  // Navigate to reminder target
  const navigateToTarget = useCallback(
    (reminder: ReminderWithTarget) => {
      switch (reminder.targetType) {
        case 'note':
        case 'highlight':
          openTab({
            type: 'note',
            title: reminder.targetTitle || 'Note',
            icon: 'file-text',
            path: `/notes/${reminder.targetId}`,
            entityId: reminder.targetId,
            isPinned: false,
            isModified: false,
            isPreview: true,
            isDeleted: false
          })
          break

        case 'journal':
          openTab({
            type: 'journal',
            title: `Journal - ${reminder.targetId}`,
            icon: 'book-open',
            path: `/journal?date=${reminder.targetId}`,
            isPinned: false,
            isModified: false,
            isPreview: false,
            isDeleted: false
          })
          break
      }
    },
    [openTab]
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
          highlight: 'Highlight reminder'
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
    const unsubscribeDue = subscribeEvent<ReminderDueEvent>('reminder-due', (event) => {
      log.info(`${event.count} reminder(s) due`)

      // Show toast for each due reminder (limit to avoid toast spam)
      const remindersToShow = event.reminders.slice(0, 5)
      for (const reminder of remindersToShow) {
        showReminderToast(reminder)
      }

      // If there are more than 5, show a summary
      if (event.count > 5) {
        toast.info(`${event.count - 5} more reminder(s) due`, {
          description: 'Check the reminders panel for details'
        })
      }
    })

    return () => {
      unsubscribeDue()
    }
  }, [showReminderToast])

  // Handle desktop notification click events (navigate to target)
  useEffect(() => {
    const unsubscribeClicked = subscribeEvent<ReminderClickedEvent>(
      'reminder-clicked',
      (event) => {
        log.info(`Desktop notification clicked for reminder ${event.reminder.id}`)
        navigateToTarget(event.reminder)
      }
    )

    return () => {
      unsubscribeClicked()
    }
  }, [navigateToTarget])
}

export default useReminderNotifications
