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
  useCreateReminder,
  useDeleteReminder,
  useDismissReminder,
  useSnoozeReminder
} from './use-reminders'
import { toast } from 'sonner'
import { extractErrorMessage } from '@/lib/ipc-error'

const log = createLogger('Hook:NoteReminders')

// ============================================================================
// Types
// ============================================================================

export interface NoteReminderActions {
  /** Create a reminder for the note */
  setReminder: (remindAt: Date, note?: string) => Promise<boolean>
  /** Create a reminder for highlighted text */
  setHighlightReminder: (
    highlightText: string,
    highlightStart: number,
    highlightEnd: number,
    remindAt: Date,
    note?: string
  ) => Promise<boolean>
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

  // Mutations
  const createReminderMutation = useCreateReminder()
  const deleteReminderMutation = useDeleteReminder()
  const dismissReminderMutation = useDismissReminder()
  const snoozeReminderMutation = useSnoozeReminder()

  // Actions
  const setReminder = useCallback(
    async (remindAt: Date, note?: string): Promise<boolean> => {
      if (!noteId) return false

      try {
        const result = await createReminderMutation.mutateAsync({
          targetType: 'note',
          targetId: noteId,
          remindAt: remindAt.toISOString(),
          note
        })

        if (result.success) {
          toast.success('Reminder set')
          return true
        } else {
          toast.error(extractErrorMessage(result.error, 'Failed to set reminder'))
          return false
        }
      } catch (err) {
        log.error('Failed to set reminder:', err)
        toast.error('Failed to set reminder')
        return false
      }
    },
    [noteId, createReminderMutation]
  )

  const setHighlightReminder = useCallback(
    async (
      highlightText: string,
      highlightStart: number,
      highlightEnd: number,
      remindAt: Date,
      note?: string
    ): Promise<boolean> => {
      if (!noteId) return false

      try {
        const result = await createReminderMutation.mutateAsync({
          targetType: 'highlight',
          targetId: noteId,
          remindAt: remindAt.toISOString(),
          highlightText,
          highlightStart,
          highlightEnd,
          note
        })

        if (result.success) {
          toast.success('Reminder set for highlighted text')
          return true
        } else {
          toast.error(extractErrorMessage(result.error, 'Failed to set reminder'))
          return false
        }
      } catch (err) {
        log.error('Failed to set highlight reminder:', err)
        toast.error('Failed to set reminder')
        return false
      }
    },
    [noteId, createReminderMutation]
  )

  const deleteReminderAction = useCallback(
    async (reminderId: string): Promise<boolean> => {
      try {
        const result = await deleteReminderMutation.mutateAsync(reminderId)

        if (result.success) {
          toast.success('Reminder deleted')
          return true
        } else {
          toast.error(extractErrorMessage(result.error, 'Failed to delete reminder'))
          return false
        }
      } catch (err) {
        log.error('Failed to delete reminder:', err)
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
          toast.error(extractErrorMessage(result.error, 'Failed to dismiss reminder'))
          return false
        }
      } catch (err) {
        log.error('Failed to dismiss reminder:', err)
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
          toast.error(extractErrorMessage(result.error, 'Failed to snooze reminder'))
          return false
        }
      } catch (err) {
        log.error('Failed to snooze reminder:', err)
        toast.error('Failed to snooze reminder')
        return false
      }
    },
    [snoozeReminderMutation]
  )

  const actions: NoteReminderActions = useMemo(
    () => ({
      setReminder,
      setHighlightReminder,
      deleteReminder: deleteReminderAction,
      dismissReminder: dismissReminderAction,
      snoozeReminder: snoozeReminderAction
    }),
    [
      setReminder,
      setHighlightReminder,
      deleteReminderAction,
      dismissReminderAction,
      snoozeReminderAction
    ]
  )

  return {
    reminders: allReminders,
    hasActiveReminder: activeReminders.length > 0,
    nextReminder,
    activeReminderCount: activeReminders.length,
    isLoading: noteRemindersLoading || highlightRemindersLoading,
    actions
  }
}
