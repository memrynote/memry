/**
 * Journal Reminders Hook
 *
 * Specialized hook for managing reminders on a specific journal entry.
 * Provides reminder state and actions for the journal editor.
 *
 * @module hooks/use-journal-reminders
 */

import { useMemo, useCallback } from 'react'
import {
  useRemindersForTarget,
  useCreateReminder,
  useDeleteReminder,
  useDismissReminder,
  useSnoozeReminder
} from './use-reminders'
import { toast } from 'sonner'

// ============================================================================
// Types
// ============================================================================

export interface JournalReminderActions {
  /** Create a reminder for the journal entry */
  setReminder: (remindAt: Date, note?: string) => Promise<boolean>
  /** Delete a reminder */
  deleteReminder: (reminderId: string) => Promise<boolean>
  /** Dismiss a reminder */
  dismissReminder: (reminderId: string) => Promise<boolean>
  /** Snooze a reminder */
  snoozeReminder: (reminderId: string, snoozeUntil: Date) => Promise<boolean>
}

export interface UseJournalRemindersResult {
  /** All reminders for this journal entry */
  reminders: ReturnType<typeof useRemindersForTarget>['reminders']
  /** Whether there are any active (pending/snoozed) reminders */
  hasActiveReminder: boolean
  /** The next upcoming reminder (if any) */
  nextReminder: ReturnType<typeof useRemindersForTarget>['reminders'][0] | null
  /** Count of active reminders */
  activeReminderCount: number
  /** Whether reminders are loading */
  isLoading: boolean
  /** Reminder actions */
  actions: JournalReminderActions
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Hook for managing reminders on a journal entry
 * @param journalDate - Journal date in YYYY-MM-DD format
 */
export function useJournalReminders(journalDate: string | null): UseJournalRemindersResult {
  // Fetch reminders for this journal entry
  const { reminders, isLoading, hasReminders: _hasReminders } = useRemindersForTarget(
    'journal',
    journalDate ?? ''
  )

  // Filter for active reminders (pending or snoozed)
  const activeReminders = useMemo(() => {
    return reminders.filter((r) => r.status === 'pending' || r.status === 'snoozed')
  }, [reminders])

  // Get next upcoming reminder
  const nextReminder = useMemo(() => {
    if (activeReminders.length === 0) return null
    // Sort by remindAt and get the first one
    const sorted = [...activeReminders].sort(
      (a, b) => new Date(a.remindAt).getTime() - new Date(b.remindAt).getTime()
    )
    return sorted[0]
  }, [activeReminders])

  // Mutations
  const createReminderMutation = useCreateReminder()
  const deleteReminderMutation = useDeleteReminder()
  const dismissReminderMutation = useDismissReminder()
  const snoozeReminderMutation = useSnoozeReminder()

  // Actions
  const setReminder = useCallback(
    async (remindAt: Date, note?: string): Promise<boolean> => {
      if (!journalDate) return false

      try {
        const result = await createReminderMutation.mutateAsync({
          targetType: 'journal',
          targetId: journalDate,
          remindAt: remindAt.toISOString(),
          note
        })

        if (result.success) {
          toast.success('Reminder set for this journal entry')
          return true
        } else {
          toast.error(result.error || 'Failed to set reminder')
          return false
        }
      } catch (err) {
        console.error('Failed to set journal reminder:', err)
        toast.error('Failed to set reminder')
        return false
      }
    },
    [journalDate, createReminderMutation]
  )

  const deleteReminderAction = useCallback(
    async (reminderId: string): Promise<boolean> => {
      try {
        const result = await deleteReminderMutation.mutateAsync(reminderId)

        if (result.success) {
          toast.success('Reminder deleted')
          return true
        } else {
          toast.error(result.error || 'Failed to delete reminder')
          return false
        }
      } catch (err) {
        console.error('Failed to delete reminder:', err)
        toast.error('Failed to delete reminder')
        return false
      }
    },
    [deleteReminderMutation]
  )

  const dismissReminderAction = useCallback(
    async (reminderId: string): Promise<boolean> => {
      try {
        const result = await dismissReminderMutation.mutateAsync(reminderId)

        if (result.success) {
          toast.success('Reminder dismissed')
          return true
        } else {
          toast.error(result.error || 'Failed to dismiss reminder')
          return false
        }
      } catch (err) {
        console.error('Failed to dismiss reminder:', err)
        toast.error('Failed to dismiss reminder')
        return false
      }
    },
    [dismissReminderMutation]
  )

  const snoozeReminderAction = useCallback(
    async (reminderId: string, snoozeUntil: Date): Promise<boolean> => {
      try {
        const result = await snoozeReminderMutation.mutateAsync({
          id: reminderId,
          snoozeUntil: snoozeUntil.toISOString()
        })

        if (result.success) {
          toast.success('Reminder snoozed')
          return true
        } else {
          toast.error(result.error || 'Failed to snooze reminder')
          return false
        }
      } catch (err) {
        console.error('Failed to snooze reminder:', err)
        toast.error('Failed to snooze reminder')
        return false
      }
    },
    [snoozeReminderMutation]
  )

  const actions: JournalReminderActions = useMemo(
    () => ({
      setReminder,
      deleteReminder: deleteReminderAction,
      dismissReminder: dismissReminderAction,
      snoozeReminder: snoozeReminderAction
    }),
    [setReminder, deleteReminderAction, dismissReminderAction, snoozeReminderAction]
  )

  return {
    reminders,
    hasActiveReminder: activeReminders.length > 0,
    nextReminder,
    activeReminderCount: activeReminders.length,
    isLoading,
    actions
  }
}
