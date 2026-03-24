/**
 * Journal Reminder Button
 *
 * Button that opens the reminder picker for a journal entry.
 * Shows an indicator when reminders are set.
 * Uses journal-specific presets (reflection intervals).
 *
 * @module components/journal/journal-reminder-button
 */

import * as React from 'react'
import { Bell, BellRing } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ReminderPicker } from '@/components/reminder'
import { formatReminderDate } from '@/components/reminder/reminder-presets'
import { useJournalReminders } from '@/hooks/use-journal-reminders'
import { cn } from '@/lib/utils'

// ============================================================================
// Types
// ============================================================================

interface JournalReminderButtonProps {
  /** Journal date in YYYY-MM-DD format */
  journalDate: string
  disabled?: boolean
  className?: string
}

// ============================================================================
// Component
// ============================================================================

export function JournalReminderButton({
  journalDate,
  disabled = false,
  className
}: JournalReminderButtonProps): React.ReactElement {
  const { hasActiveReminder, nextReminder, activeReminderCount, actions } =
    useJournalReminders(journalDate)

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
    : 'Set reminder to revisit'

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="relative">
          <ReminderPicker
            onSelect={(time, note) => void handleSetReminder(time, note)}
            presetType="journal"
            showNote
            disabled={disabled}
            trigger={
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  'size-8 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-foreground/5 transition-all duration-200',
                  className
                )}
                disabled={disabled}
              >
                {hasActiveReminder ? (
                  <BellRing className="size-4 text-amber-500" />
                ) : (
                  <Bell className="size-4" />
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
