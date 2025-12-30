/**
 * Reminders List Component
 *
 * Displays all upcoming reminders grouped by time period.
 * Provides actions to snooze, dismiss, or navigate to the reminder target.
 *
 * @module components/reminder/reminders-list
 */

import * as React from 'react'
import { useCallback, useMemo } from 'react'
import {
  Bell,
  BellOff,
  Clock,
  FileText,
  BookOpen,
  Highlighter,
  ChevronRight,
  MoreHorizontal,
  X,
  AlertTriangle
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import {
  useUpcomingReminders,
  useDismissReminder,
  useSnoozeReminder,
  useDeleteReminder,
  useBulkDismissReminders
} from '@/hooks/use-reminders'
import {
  formatReminderDate,
  isOverdue,
  snoozePresets
} from './reminder-presets'
import type { ReminderWithTarget } from '@/services/reminder-service'

// ============================================================================
// Types
// ============================================================================

interface RemindersListProps {
  /** Called when user clicks on a reminder to navigate to it */
  onNavigate?: (reminder: ReminderWithTarget) => void
  /** Called when list should be closed */
  onClose?: () => void
  /** Maximum height of the list */
  maxHeight?: string
  /** Show header with close button */
  showHeader?: boolean
  /** Class name for container */
  className?: string
}

interface ReminderGroup {
  label: string
  reminders: ReminderWithTarget[]
}

// ============================================================================
// Helper Functions
// ============================================================================

function groupRemindersByTime(reminders: ReminderWithTarget[]): ReminderGroup[] {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const tomorrow = new Date(today)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const nextWeek = new Date(today)
  nextWeek.setDate(nextWeek.getDate() + 7)

  const groups: Record<string, ReminderWithTarget[]> = {
    overdue: [],
    today: [],
    tomorrow: [],
    thisWeek: [],
    later: []
  }

  for (const reminder of reminders) {
    const remindAt = new Date(reminder.remindAt)

    if (isOverdue(remindAt)) {
      groups.overdue.push(reminder)
    } else if (remindAt < tomorrow) {
      groups.today.push(reminder)
    } else if (remindAt < new Date(tomorrow.getTime() + 24 * 60 * 60 * 1000)) {
      groups.tomorrow.push(reminder)
    } else if (remindAt < nextWeek) {
      groups.thisWeek.push(reminder)
    } else {
      groups.later.push(reminder)
    }
  }

  const result: ReminderGroup[] = []

  if (groups.overdue.length > 0) {
    result.push({ label: 'Overdue', reminders: groups.overdue })
  }
  if (groups.today.length > 0) {
    result.push({ label: 'Today', reminders: groups.today })
  }
  if (groups.tomorrow.length > 0) {
    result.push({ label: 'Tomorrow', reminders: groups.tomorrow })
  }
  if (groups.thisWeek.length > 0) {
    result.push({ label: 'This Week', reminders: groups.thisWeek })
  }
  if (groups.later.length > 0) {
    result.push({ label: 'Later', reminders: groups.later })
  }

  return result
}

function getTargetIcon(targetType: string): React.ReactNode {
  switch (targetType) {
    case 'note':
      return <FileText className="h-4 w-4" />
    case 'journal':
      return <BookOpen className="h-4 w-4" />
    case 'highlight':
      return <Highlighter className="h-4 w-4" />
    default:
      return <FileText className="h-4 w-4" />
  }
}

// ============================================================================
// Reminder Item Component
// ============================================================================

interface ReminderItemProps {
  reminder: ReminderWithTarget
  onNavigate?: (reminder: ReminderWithTarget) => void
  onDismiss: (id: string) => void
  onSnooze: (id: string, until: Date) => void
  onDelete: (id: string) => void
}

function ReminderItem({
  reminder,
  onNavigate,
  onDismiss,
  onSnooze,
  onDelete
}: ReminderItemProps): React.ReactElement {
  const remindAt = new Date(reminder.remindAt)
  const overdue = isOverdue(remindAt)
  // T235: Check if target still exists
  const targetDeleted = reminder.targetExists === false

  const handleClick = useCallback(() => {
    // T235: Don't navigate if target is deleted
    if (targetDeleted) return
    onNavigate?.(reminder)
  }, [reminder, onNavigate, targetDeleted])

  const title =
    reminder.title ||
    reminder.targetTitle ||
    (reminder.targetType === 'highlight'
      ? reminder.highlightText?.slice(0, 50) + '...'
      : 'Untitled')

  return (
    <div
      className={cn(
        'group flex items-start gap-3 p-3 rounded-lg transition-colors',
        !targetDeleted && 'cursor-pointer hover:bg-muted/50',
        targetDeleted && 'opacity-60 cursor-not-allowed',
        overdue && !targetDeleted && 'bg-destructive/5'
      )}
      onClick={handleClick}
    >
      {/* Icon */}
      <div
        className={cn(
          'flex-shrink-0 mt-0.5 text-muted-foreground',
          overdue && !targetDeleted && 'text-destructive',
          targetDeleted && 'text-amber-500'
        )}
      >
        {targetDeleted ? <AlertTriangle className="h-4 w-4" /> : getTargetIcon(reminder.targetType)}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className={cn('font-medium text-sm truncate', targetDeleted && 'line-through')}>{title}</p>

            {/* T235: Show deleted warning */}
            {targetDeleted && (
              <p className="text-xs text-amber-600 mt-0.5">
                <AlertTriangle className="inline h-3 w-3 mr-1" />
                Content no longer exists
              </p>
            )}

            {/* Time */}
            {!targetDeleted && (
              <p
                className={cn(
                  'text-xs mt-0.5',
                  overdue ? 'text-destructive' : 'text-muted-foreground'
                )}
              >
                <Clock className="inline h-3 w-3 mr-1" />
                {overdue ? 'Overdue: ' : ''}
                {formatReminderDate(remindAt)}
              </p>
            )}

            {/* Note preview */}
            {reminder.note && !targetDeleted && (
              <p className="text-xs text-muted-foreground mt-1 line-clamp-1">{reminder.note}</p>
            )}

            {/* Highlight preview */}
            {reminder.targetType === 'highlight' && reminder.highlightText && !targetDeleted && (
              <p className="text-xs text-muted-foreground mt-1 line-clamp-2 italic border-l-2 border-muted pl-2">
                "{reminder.highlightText}"
              </p>
            )}
          </div>

          {/* Actions */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreHorizontal className="h-4 w-4" />
                <span className="sr-only">Actions</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
              {/* Snooze options */}
              {snoozePresets.map((preset) => (
                <DropdownMenuItem
                  key={preset.id}
                  onClick={() => onSnooze(reminder.id, preset.getDate())}
                >
                  <Clock className="mr-2 h-4 w-4" />
                  Snooze {preset.label.toLowerCase()}
                </DropdownMenuItem>
              ))}

              <DropdownMenuSeparator />

              <DropdownMenuItem onClick={() => onDismiss(reminder.id)}>
                <BellOff className="mr-2 h-4 w-4" />
                Dismiss
              </DropdownMenuItem>

              <DropdownMenuItem
                onClick={() => onDelete(reminder.id)}
                className="text-destructive focus:text-destructive"
              >
                <X className="mr-2 h-4 w-4" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Navigate chevron */}
      <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 mt-1" />
    </div>
  )
}

// ============================================================================
// Empty State Component
// ============================================================================

function EmptyState(): React.ReactElement {
  return (
    <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
      <Bell className="h-12 w-12 text-muted-foreground/30 mb-4" />
      <h3 className="font-medium text-sm">No upcoming reminders</h3>
      <p className="text-xs text-muted-foreground mt-1 max-w-[200px]">
        Set reminders on notes and journal entries to be notified later
      </p>
    </div>
  )
}

// ============================================================================
// Main Component
// ============================================================================

export function RemindersList({
  onNavigate,
  onClose,
  maxHeight = '500px',
  showHeader = true,
  className
}: RemindersListProps): React.ReactElement {
  // Fetch upcoming reminders (next 30 days)
  const { reminders, total, isLoading } = useUpcomingReminders(30)

  // Mutations
  const dismissMutation = useDismissReminder()
  const snoozeMutation = useSnoozeReminder()
  const deleteMutation = useDeleteReminder()
  const bulkDismissMutation = useBulkDismissReminders()

  // Group reminders by time
  const groups = useMemo(() => groupRemindersByTime(reminders), [reminders])

  // T236: Get overdue reminders for bulk dismiss
  const overdueReminders = useMemo(() => {
    const overdueGroup = groups.find((g) => g.label === 'Overdue')
    return overdueGroup?.reminders || []
  }, [groups])

  // Handlers
  const handleDismiss = useCallback(
    (id: string) => {
      dismissMutation.mutate(id)
    },
    [dismissMutation]
  )

  const handleSnooze = useCallback(
    (id: string, until: Date) => {
      snoozeMutation.mutate({ id, snoozeUntil: until.toISOString() })
    },
    [snoozeMutation]
  )

  const handleDelete = useCallback(
    (id: string) => {
      deleteMutation.mutate(id)
    },
    [deleteMutation]
  )

  // T236: Handle bulk dismiss of overdue reminders
  const handleBulkDismissOverdue = useCallback(() => {
    if (overdueReminders.length === 0) return
    const ids = overdueReminders.map((r) => r.id)
    bulkDismissMutation.mutate(ids)
  }, [overdueReminders, bulkDismissMutation])

  return (
    <div className={cn('flex flex-col', className)}>
      {/* Header */}
      {showHeader && (
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <div className="flex items-center gap-2">
            <Bell className="h-4 w-4" />
            <h2 className="font-semibold text-sm">Reminders</h2>
            {total > 0 && (
              <span className="text-xs text-muted-foreground">({total})</span>
            )}
          </div>
          {onClose && (
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
              <X className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </Button>
          )}
        </div>
      )}

      {/* Content */}
      <ScrollArea style={{ maxHeight }}>
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full" />
          </div>
        ) : reminders.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="p-2">
            {groups.map((group) => (
              <div key={group.label} className="mb-4 last:mb-0">
                {/* Group header with optional bulk action */}
                <div className="flex items-center justify-between px-3 py-1.5">
                  <h3
                    className={cn(
                      'text-xs font-medium uppercase tracking-wider',
                      group.label === 'Overdue' ? 'text-destructive' : 'text-muted-foreground'
                    )}
                  >
                    {group.label}
                  </h3>

                  {/* T236: Bulk dismiss button for overdue reminders */}
                  {group.label === 'Overdue' && group.reminders.length > 1 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 text-xs text-destructive hover:text-destructive"
                      onClick={handleBulkDismissOverdue}
                      disabled={bulkDismissMutation.isPending}
                    >
                      <BellOff className="h-3 w-3 mr-1" />
                      Dismiss All ({group.reminders.length})
                    </Button>
                  )}
                </div>

                {/* Group items */}
                <div className="space-y-1">
                  {group.reminders.map((reminder) => (
                    <ReminderItem
                      key={reminder.id}
                      reminder={reminder}
                      onNavigate={onNavigate}
                      onDismiss={handleDismiss}
                      onSnooze={handleSnooze}
                      onDelete={handleDelete}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}
