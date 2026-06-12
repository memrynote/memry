/**
 * Task Reminders Hook
 *
 * Specialized hook for managing reminders on a specific task.
 * Provides reminder state and actions for the task detail drawer.
 *
 * @module hooks/use-task-reminders
 */

import { useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { createLogger } from '@/lib/logger'
import { extractErrorMessage } from '@/lib/ipc-error'
import {
  useRemindersForTarget,
  useCreateReminder,
  useUpdateReminder,
  useDeleteReminder
} from './use-reminders'

const log = createLogger('Hook:TaskReminders')

// ============================================================================
// Types
// ============================================================================

export interface TaskReminderActions {
  /** Create a reminder for the task */
  setReminder: (remindAt: Date, note?: string) => Promise<boolean>
  /** Edit an existing reminder's time and/or note */
  editReminder: (reminderId: string, remindAt: Date, note?: string) => Promise<boolean>
  /** Delete a reminder */
  deleteReminder: (reminderId: string) => Promise<boolean>
}

export interface UseTaskRemindersResult {
  /** All reminders for this task */
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
  actions: TaskReminderActions
}

// ============================================================================
// Hook
// ============================================================================

export function useTaskReminders(taskId: string | null): UseTaskRemindersResult {
  const { t } = useT('tasks')

  const { reminders: taskReminders, isLoading } = useRemindersForTarget('task', taskId ?? '')

  const allReminders = useMemo(
    () =>
      [...taskReminders].sort(
        (a, b) => new Date(a.remindAt).getTime() - new Date(b.remindAt).getTime()
      ),
    [taskReminders]
  )

  const activeReminders = useMemo(
    () => allReminders.filter((r) => r.status === 'pending' || r.status === 'snoozed'),
    [allReminders]
  )

  const nextReminder = activeReminders[0] ?? null

  const createReminderMutation = useCreateReminder()
  const updateReminderMutation = useUpdateReminder()
  const deleteReminderMutation = useDeleteReminder()

  const setReminder = useCallback(
    async (remindAt: Date, note?: string): Promise<boolean> => {
      if (!taskId) return false

      try {
        const result = await createReminderMutation.mutateAsync({
          targetType: 'task',
          targetId: taskId,
          remindAt: remindAt.toISOString(),
          note
        })

        if (result.success) {
          toast.success(t('reminders.toast.set'))
          return true
        }
        toast.error(extractErrorMessage(result.error, t('reminders.toast.setFailed')))
        return false
      } catch (err) {
        log.error('Failed to set reminder:', err)
        toast.error(t('reminders.toast.setFailed'))
        return false
      }
    },
    [taskId, createReminderMutation, t]
  )

  const editReminder = useCallback(
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
        }
        toast.error(extractErrorMessage(result.error, t('reminders.toast.updateFailed')))
        return false
      } catch (err) {
        log.error('Failed to edit reminder:', err)
        toast.error(t('reminders.toast.updateFailed'))
        return false
      }
    },
    [updateReminderMutation, t]
  )

  const deleteReminder = useCallback(
    async (reminderId: string): Promise<boolean> => {
      try {
        const result = await deleteReminderMutation.mutateAsync(reminderId)

        if (result.success) {
          toast.success(t('reminders.toast.deleted'))
          return true
        }
        toast.error(extractErrorMessage(result.error, t('reminders.toast.deleteFailed')))
        return false
      } catch (err) {
        log.error('Failed to delete reminder:', err)
        toast.error(t('reminders.toast.deleteFailed'))
        return false
      }
    },
    [deleteReminderMutation, t]
  )

  const actions: TaskReminderActions = useMemo(
    () => ({ setReminder, editReminder, deleteReminder }),
    [setReminder, editReminder, deleteReminder]
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
