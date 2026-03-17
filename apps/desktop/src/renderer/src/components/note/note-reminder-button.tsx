/**
 * Note Reminder Button
 *
 * Button that opens the reminder picker for a note.
 * Shows an indicator when reminders are set.
 *
 * @module components/note/note-reminder-button
 */

import * as React from 'react'
import { Bell, BellRing } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ReminderPicker } from '@/components/reminder'
import { formatReminderDate } from '@/components/reminder/reminder-presets'
import { useNoteReminders } from '@/hooks/use-note-reminders'
import { cn } from '@/lib/utils'

// ============================================================================
// Types
// ============================================================================

interface NoteReminderButtonProps {
  noteId: string
  disabled?: boolean
  className?: string
}

// ============================================================================
// Component
// ============================================================================

export function NoteReminderButton({
  noteId,
  disabled = false,
  className
}: NoteReminderButtonProps): React.ReactElement {
  const { hasActiveReminder, nextReminder, activeReminderCount, actions } = useNoteReminders(noteId)

  const handleSetReminder = async (date: Date, note?: string): Promise<void> => {
    await actions.setReminder(date, note)
  }

  // Format tooltip content
  const tooltipContent = hasActiveReminder
    ? nextReminder
      ? `Reminder: ${formatReminderDate(new Date(nextReminder.remindAt))}${
          activeReminderCount > 1 ? ` (+${activeReminderCount - 1} more)` : ''
        }`
      : 'Has reminders'
    : 'Set reminder'

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="relative">
          <ReminderPicker
            onSelect={(time, note) => void handleSetReminder(time, note)}
            presetType="standard"
            showNote
            disabled={disabled}
            trigger={
              <Button
                variant="ghost"
                size="icon"
                className={cn('h-8 w-8 hover:bg-muted/50', className)}
                disabled={disabled}
              >
                {hasActiveReminder ? (
                  <BellRing className="h-4 w-4 text-amber-500" />
                ) : (
                  <Bell className="h-4 w-4" />
                )}
                <span className="sr-only">{tooltipContent}</span>
              </Button>
            }
          />

          {/* Badge indicator for multiple reminders */}
          {activeReminderCount > 1 && (
            <span className="absolute -top-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-amber-500 text-[9px] font-medium text-white">
              {activeReminderCount > 9 ? '9+' : activeReminderCount}
            </span>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <p>{tooltipContent}</p>
      </TooltipContent>
    </Tooltip>
  )
}
