import { useT } from '@memry/i18n/renderer'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Clock, ExternalLink, FileText } from '@/lib/icons'
import { computeSnoozeOptions, type SnoozeTarget } from '@/lib/snooze-options'

export interface CalendarTaskPopoverActionsProps {
  isCompleted: boolean
  isAllDay: boolean
  sourceNoteId: string | null
  onOpenTask: () => void
  onOpenSourceNote: () => void
  onSnooze: (target: SnoozeTarget) => void
  onRemoveDueDate: () => void
  onPickDateTime: () => void
  now?: Date
}

export function CalendarTaskPopoverActions({
  isCompleted,
  isAllDay,
  sourceNoteId,
  onOpenTask,
  onOpenSourceNote,
  onSnooze,
  onRemoveDueDate,
  onPickDateTime,
  now
}: CalendarTaskPopoverActionsProps): React.JSX.Element {
  const { t } = useT('calendar')
  const opts = computeSnoozeOptions({ now: now ?? new Date(), isAllDay })

  return (
    <div className="flex items-center gap-1.5 px-2 py-2 border-t">
      <Button variant="secondary" size="sm" onClick={onOpenTask}>
        {t('task-popover.open-task')}
      </Button>

      {sourceNoteId && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onOpenSourceNote}
          aria-label={t('task-popover.source-note')}
        >
          <FileText className="h-3.5 w-3.5 me-1" />
          {t('task-popover.source-note')}
          <ExternalLink className="h-3 w-3 ms-1" />
        </Button>
      )}

      {!isCompleted && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" aria-label={t('task-popover.reschedule')}>
              <Clock className="h-3.5 w-3.5 me-1" />
              {t('task-popover.reschedule')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {opts.laterToday && (
              <DropdownMenuItem onClick={() => onSnooze(opts.laterToday!)}>
                {t('task-popover.later-today')}
                {opts.laterToday.dueTime ? ` · ${formatHHMM(opts.laterToday.dueTime)}` : ''}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => onSnooze(opts.tomorrow)}>
              {t('task-popover.tomorrow')}
              {opts.tomorrow.dueTime ? ` · ${formatHHMM(opts.tomorrow.dueTime)}` : ''}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onSnooze(opts.nextWeek)}>
              {t('task-popover.next-week-mon')}
              {opts.nextWeek.dueTime ? ` ${formatHHMM(opts.nextWeek.dueTime)}` : ''}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onPickDateTime}>
              {t('task-popover.pick-date-time')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onRemoveDueDate}>
              {t('task-popover.remove-due-date')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}

function formatHHMM(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number)
  const d = new Date()
  d.setHours(h, m, 0, 0)
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}
