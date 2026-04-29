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
  const opts = computeSnoozeOptions({ now: now ?? new Date(), isAllDay })

  return (
    <div className="flex items-center gap-1.5 px-2 py-2 border-t">
      <Button variant="secondary" size="sm" onClick={onOpenTask}>
        Open task
      </Button>

      {sourceNoteId && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onOpenSourceNote}
          aria-label="Source note"
        >
          <FileText className="h-3.5 w-3.5 me-1" />
          Source note
          <ExternalLink className="h-3 w-3 ms-1" />
        </Button>
      )}

      {!isCompleted && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" aria-label="Snooze">
              <Clock className="h-3.5 w-3.5 me-1" />
              Snooze
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {opts.laterToday && (
              <DropdownMenuItem onClick={() => onSnooze(opts.laterToday!)}>
                Later today
                {opts.laterToday.dueTime ? ` · ${formatHHMM(opts.laterToday.dueTime)}` : ''}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => onSnooze(opts.tomorrow)}>
              Tomorrow
              {opts.tomorrow.dueTime ? ` · ${formatHHMM(opts.tomorrow.dueTime)}` : ''}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onSnooze(opts.nextWeek)}>
              Next week · Mon
              {opts.nextWeek.dueTime ? ` ${formatHHMM(opts.nextWeek.dueTime)}` : ''}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onPickDateTime}>Pick date &amp; time…</DropdownMenuItem>
            <DropdownMenuItem onClick={onRemoveDueDate}>Remove due date</DropdownMenuItem>
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
