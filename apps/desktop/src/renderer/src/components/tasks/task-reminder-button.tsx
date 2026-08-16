/**
 * Task Reminder Button
 *
 * Badge trigger that opens the reminder picker for a task. Shows the next
 * reminder's date when set (with a +N pill for additional reminders), and a
 * "Set reminder" affordance when empty. The picker lists existing reminders
 * with edit and delete actions.
 *
 * @module components/tasks/task-reminder-button
 */

import * as React from 'react'
import { Bell, BellRing } from '@/lib/icons'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { ReminderPicker } from '@/components/reminder'
import { formatReminderDate } from '@/components/reminder/reminder-presets'
import { useTaskReminders } from '@/hooks/use-task-reminders'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'

interface TaskReminderButtonProps {
  taskId: string
  disabled?: boolean
  className?: string
}

export function TaskReminderButton({
  taskId,
  disabled = false,
  className
}: TaskReminderButtonProps): React.ReactElement {
  const { t } = useT('tasks')
  const {
    settings: { clockFormat }
  } = useGeneralSettings()
  const { activeReminders, hasActiveReminder, nextReminder, activeReminderCount, actions } =
    useTaskReminders(taskId)

  const label =
    hasActiveReminder && nextReminder
      ? formatReminderDate(new Date(nextReminder.remindAt), clockFormat, true)
      : t('reminders.setReminder')

  const ariaLabel = hasActiveReminder
    ? nextReminder
      ? activeReminderCount > 1
        ? t('reminders.summaryWithMore', {
            date: formatReminderDate(new Date(nextReminder.remindAt), clockFormat),
            count: activeReminderCount - 1
          })
        : t('reminders.summary', {
            date: formatReminderDate(new Date(nextReminder.remindAt), clockFormat)
          })
      : t('reminders.hasReminders')
    : t('reminders.setReminder')

  return (
    <ReminderPicker
      onSelect={(date, note) => void actions.setReminder(date, note)}
      presetType="standard"
      telemetrySurface="tasks"
      showNote
      disabled={disabled}
      reminders={activeReminders}
      onEdit={(id, date, note) => void actions.editReminder(id, date, note)}
      onDelete={(id) => void actions.deleteReminder(id)}
      trigger={
        <button
          type="button"
          disabled={disabled}
          aria-label={ariaLabel}
          className={cn(
            'flex items-center gap-1.5 cursor-pointer whitespace-nowrap rounded-[5px] py-[3px] px-2 border border-solid',
            'border-foreground/10 bg-foreground/[0.03] dark:bg-foreground/[0.06]',
            'transition-opacity hover:opacity-80 focus-visible:outline-none',
            'disabled:cursor-not-allowed disabled:opacity-50',
            hasActiveReminder ? 'text-text-secondary' : 'text-text-tertiary',
            className
          )}
        >
          {hasActiveReminder ? (
            <BellRing className="size-3 shrink-0 text-amber-500" />
          ) : (
            <Bell className="size-3 shrink-0" />
          )}
          <span className="text-[12px] leading-4">{label}</span>
          {activeReminderCount > 1 && (
            <span className="rounded-[3px] bg-foreground/10 px-1 text-[10px] font-medium leading-4 text-text-secondary">
              +{activeReminderCount - 1}
            </span>
          )}
        </button>
      }
    />
  )
}
