import { getI18n } from 'react-i18next'
/**
 * Note Reminders Hook
 *
 * Specialized hook for managing reminders on a specific note.
 * Provides reminder state and actions for the note editor.
 *
 * @module hooks/use-note-reminders
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

const log = createLogger('Hook:NoteReminders')

// ============================================================================
// Types
// ============================================================================

export interface NoteReminderActions {
  /** Set the note's reminder, moving the active one when it already has it */
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

export interface UseNoteRemindersResult {
  /** All reminders for this note (including highlight reminders) */
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
  actions: NoteReminderActions
}

// ============================================================================
// Hook
// ============================================================================

export function useNoteReminders(noteId: string | null): UseNoteRemindersResult {
  const { t } = useT('notes')

  // Fetch reminders for this note (includes both note and highlight reminders)
  const { reminders: noteReminders, isLoading: noteRemindersLoading } = useRemindersForTarget(
    'note',
    noteId ?? ''
  )

  const { reminders: highlightReminders, isLoading: highlightRemindersLoading } =
    useRemindersForTarget('highlight', noteId ?? '')

  // Combine and sort all reminders
  const allReminders = useMemo(() => {
    return [...noteReminders, ...highlightReminders].sort(
      (a, b) => new Date(a.remindAt).getTime() - new Date(b.remindAt).getTime()
    )
  }, [noteReminders, highlightReminders])

  // Filter for active reminders (pending or snoozed)
  const activeReminders = useMemo(() => {
    return allReminders.filter((r) => r.status === 'pending' || r.status === 'snoozed')
  }, [allReminders])

  // Get next upcoming reminder
  const nextReminder = useMemo(() => {
    if (activeReminders.length === 0) return null
    return activeReminders[0] // Already sorted by remindAt
  }, [activeReminders])

  /**
   * The bell sets a reminder on the note itself, so only a reminder on the note
   * is replaced by a new time. A highlight reminder is anchored to a passage:
   * it is listed and removable here, but moving it from the note toolbar would
   * silently reschedule something the user never opened.
   */
  const replaceableReminder = useMemo(() => {
    const active = noteReminders.filter((r) => r.status === 'pending' || r.status === 'snoozed')
    const sorted = [...active].sort(
      (a, b) => new Date(a.remindAt).getTime() - new Date(b.remindAt).getTime()
    )
    return sorted[0] ?? null
  }, [noteReminders])

  // Mutations
  const setOrReplaceReminder = useSetOrReplaceReminder()
  const updateReminderMutation = useUpdateReminder()
  const deleteReminderMutation = useDeleteReminder()
  const dismissReminderMutation = useDismissReminder()
  const snoozeReminderMutation = useSnoozeReminder()

  // Actions
  const setReminder = useCallback(
    async (remindAt: Date, note?: string): Promise<boolean> => {
      if (!noteId) return false

      const replacingId = replaceableReminder?.id ?? null
      const success = replacingId ? t('reminders.toast.updated') : t('reminders.toast.set')
      const failure = replacingId
        ? t('reminders.toast.updateFailed')
        : t('reminders.toast.setFailed')

      try {
        const result = await setOrReplaceReminder(
          {
            targetType: 'note',
            targetId: noteId,
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
        log.error('Failed to set reminder:', err)
        toast.error(failure)
        return false
      }
    },
    [noteId, replaceableReminder, setOrReplaceReminder, t]
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
          toast.success(t('reminders.toast.updated'))
          return true
        } else {
          toast.error(extractErrorMessage(result.error, t('reminders.toast.updateFailed')))
          return false
        }
      } catch (err) {
        log.error('Failed to edit reminder:', err)
        toast.error(t('reminders.toast.updateFailed'))
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
          toast.success(t('reminders.toast.deleted'))
          return true
        } else {
          toast.error(extractErrorMessage(result.error, t('reminders.toast.deleteFailed')))
          return false
        }
      } catch (err) {
        log.error('Failed to delete reminder:', err)
        toast.error(t('reminders.toast.deleteFailed'))
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
          toast.success(t('reminders.toast.dismissed'))
          return true
        } else {
          toast.error(extractErrorMessage(result.error, t('reminders.toast.dismissFailed')))
          return false
        }
      } catch (err) {
        log.error('Failed to dismiss reminder:', err)
        toast.error(t('reminders.toast.dismissFailed'))
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
          toast.success(getI18n().getFixedT(null, 'notes')('phaseI.toasts.reminderSnoozed'))
          return true
        } else {
          toast.error(
            extractErrorMessage(
              result.error,
              getI18n().getFixedT(null, 'notes')('phaseI.errors.failedToSnoozeReminder')
            )
          )
          return false
        }
      } catch (err) {
        log.error('Failed to snooze reminder:', err)
        toast.error(getI18n().getFixedT(null, 'notes')('phaseI.toasts.failedToSnoozeReminder'))
        return false
      }
    },
    [snoozeReminderMutation]
  )

  const actions: NoteReminderActions = useMemo(
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
    isLoading: noteRemindersLoading || highlightRemindersLoading,
    actions
  }
}
