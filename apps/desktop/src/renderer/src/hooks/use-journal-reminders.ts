/**
 * Journal Reminders Hook
 *
 * Specialized hook for managing reminders on a specific journal entry.
 * Provides reminder state and actions for the journal editor.
 *
 * @module hooks/use-journal-reminders
 */

import { useMemo, useCallback } from 'react'
import { createLogger } from '@/lib/logger'
import {
  useRemindersForTarget,
  useUpdateReminder,
  useDeleteReminder,
  useDismissReminder,
  useSnoozeReminder
} from './use-reminders'
import { useSetOrReplaceReminder } from './use-set-or-replace-reminder'
import { toast } from 'sonner'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useT } from '@memry/i18n/renderer'

const log = createLogger('Hook:JournalReminders')

// ============================================================================
// Types
// ============================================================================

export interface JournalReminderActions {
  /** Set the entry's reminder, moving the active one when it already has it */
  setReminder: (remindAt: Date, note?: string) => Promise<boolean>
  /** Edit an existing reminder's time and/or note */
  editReminder: (reminderId: string, remindAt: Date, note?: string) => Promise<boolean>
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
  /** Active (pending/snoozed) reminders, sorted by remindAt */
  activeReminders: ReturnType<typeof useRemindersForTarget>['reminders']
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
  const { t } = useT('journal')
  // Fetch reminders for this journal entry
  const {
    reminders,
    isLoading,
    hasReminders: _hasReminders
  } = useRemindersForTarget('journal', journalDate ?? '')

  const allReminders = useMemo(
    () =>
      [...reminders].sort(
        (a, b) => new Date(a.remindAt).getTime() - new Date(b.remindAt).getTime()
      ),
    [reminders]
  )

  const activeReminders = useMemo(
    () => allReminders.filter((r) => r.status === 'pending' || r.status === 'snoozed'),
    [allReminders]
  )

  const nextReminder = activeReminders[0] ?? null

  // Mutations
  const setOrReplaceReminder = useSetOrReplaceReminder()
  const updateReminderMutation = useUpdateReminder()
  const deleteReminderMutation = useDeleteReminder()
  const dismissReminderMutation = useDismissReminder()
  const snoozeReminderMutation = useSnoozeReminder()

  // Actions
  const setReminder = useCallback(
    async (remindAt: Date, note?: string): Promise<boolean> => {
      if (!journalDate) return false

      const replacingId = nextReminder?.id ?? null
      const success = replacingId ? t('reminder.success.updated') : t('reminder.success.set')
      const failure = replacingId ? t('reminder.error.update') : t('reminder.error.set')

      try {
        const result = await setOrReplaceReminder(
          {
            targetType: 'journal',
            targetId: journalDate,
            remindAt: remindAt.toISOString(),
            note
          },
          replacingId
        )

        if (result.success) {
          toast.success(success)
          return true
        } else {
          toast.error(extractErrorMessage(result.error, failure))
          return false
        }
      } catch (err) {
        log.error('Failed to set journal reminder:', err)
        toast.error(failure)
        return false
      }
    },
    [journalDate, nextReminder, setOrReplaceReminder, t]
  )

  const editReminderAction = useCallback(
    async (reminderId: string, remindAt: Date, note?: string): Promise<boolean> => {
      try {
        const result = await updateReminderMutation.mutateAsync({
          id: reminderId,
          remindAt: remindAt.toISOString(),
          note
        })

        if (result.success) {
          toast.success(t('reminder.success.updated'))
          return true
        } else {
          toast.error(extractErrorMessage(result.error, t('reminder.error.update')))
          return false
        }
      } catch (err) {
        log.error('Failed to edit journal reminder:', err)
        toast.error(t('reminder.error.update'))
        return false
      }
    },
    [updateReminderMutation, t]
  )

  const deleteReminderAction = useCallback(
    async (reminderId: string): Promise<boolean> => {
      try {
        const result = await deleteReminderMutation.mutateAsync(reminderId)

        if (result.success) {
          toast.success(t('reminder.success.deleted'))
          return true
        } else {
          toast.error(extractErrorMessage(result.error, t('reminder.error.delete')))
          return false
        }
      } catch (err) {
        log.error('Failed to delete reminder:', err)
        toast.error(t('reminder.error.delete'))
        return false
      }
    },
    [deleteReminderMutation, t]
  )

  const dismissReminderAction = useCallback(
    async (reminderId: string): Promise<boolean> => {
      try {
        const result = await dismissReminderMutation.mutateAsync(reminderId)

        if (result.success) {
          toast.success(t('reminder.success.dismissed'))
          return true
        } else {
          toast.error(extractErrorMessage(result.error, t('reminder.error.dismiss')))
          return false
        }
      } catch (err) {
        log.error('Failed to dismiss reminder:', err)
        toast.error(t('reminder.error.dismiss'))
        return false
      }
    },
    [dismissReminderMutation, t]
  )

  const snoozeReminderAction = useCallback(
    async (reminderId: string, snoozeUntil: Date): Promise<boolean> => {
      try {
        const result = await snoozeReminderMutation.mutateAsync({
          id: reminderId,
          snoozeUntil: snoozeUntil.toISOString()
        })

        if (result.success) {
          toast.success(t('reminder.success.snoozed'))
          return true
        } else {
          toast.error(extractErrorMessage(result.error, t('reminder.error.snooze')))
          return false
        }
      } catch (err) {
        log.error('Failed to snooze reminder:', err)
        toast.error(t('reminder.error.snooze'))
        return false
      }
    },
    [snoozeReminderMutation, t]
  )

  const actions: JournalReminderActions = useMemo(
    () => ({
      setReminder,
      editReminder: editReminderAction,
      deleteReminder: deleteReminderAction,
      dismissReminder: dismissReminderAction,
      snoozeReminder: snoozeReminderAction
    }),
    [
      setReminder,
      editReminderAction,
      deleteReminderAction,
      dismissReminderAction,
      snoozeReminderAction
    ]
  )

  return {
    reminders: allReminders,
    activeReminders,
    hasActiveReminder: activeReminders.length > 0,
    nextReminder,
    activeReminderCount: activeReminders.length,
    isLoading,
    actions
  }
}
