/**
 * Set-or-replace Reminder Hook
 *
 * A journal entry and a note each carry one reminder. Picking a time while one
 * is already active moves that reminder instead of appending a second row, so a
 * custom time chosen after a preset replaces the preset rather than firing
 * twice. Both surfaces share this so the rule cannot drift between them.
 *
 * @module hooks/use-set-or-replace-reminder
 */

import { useCallback } from 'react'
import type { CreateReminderInput } from '@/services/reminder-service'
import { useCreateReminder, useUpdateReminder } from './use-reminders'

export interface SetOrReplaceReminderResult {
  success: boolean
  error?: string
}

export type SetOrReplaceReminder = (
  input: CreateReminderInput,
  replacingId: string | null
) => Promise<SetOrReplaceReminderResult>

/**
 * @returns A function taking the reminder to write and the id of the active
 *   reminder it replaces, or `null` when the target has none.
 */
export function useSetOrReplaceReminder(): SetOrReplaceReminder {
  const createReminder = useCreateReminder()
  const updateReminder = useUpdateReminder()

  return useCallback(
    (input, replacingId) =>
      replacingId === null
        ? createReminder.mutateAsync(input)
        : updateReminder.mutateAsync({
            id: replacingId,
            remindAt: input.remindAt,
            // Written through as null so replacing also clears a note the
            // previous reminder carried and the picker came back without.
            note: input.note ?? null
          }),
    [createReminder, updateReminder]
  )
}
