import { useT } from '@memry/i18n/renderer'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { CalendarClock, FileText, MoreHorizontal, X } from '@/lib/icons'
import { getActiveLocale } from '@/lib/active-locale'
import { computeSnoozeOptions, type SnoozeTarget } from '@/lib/snooze-options'
import {
  CARD_ICON_BUTTON_CLASS,
  CalendarCardAction,
  CalendarCardActionBar,
  CalendarCardSection,
  MOD_KEY_LABEL
} from './calendar-card'

const MOVE_BUTTON_CLASS =
  'inline-flex h-[26px] items-center rounded-md bg-foreground/[0.06] px-2.5 text-xs font-medium text-foreground outline-none transition-colors hover:bg-foreground/10 focus-visible:ring-1 focus-visible:ring-(--tint-ring)'

export interface CalendarTaskPopoverMoveRowProps {
  isAllDay: boolean
  onSnooze: (target: SnoozeTarget) => void
  now?: Date
}

/** One-click reschedule: no date picker between the user and "not today". */
export function CalendarTaskPopoverMoveRow({
  isAllDay,
  onSnooze,
  now
}: CalendarTaskPopoverMoveRowProps): React.JSX.Element {
  const { t } = useT('calendar')
  const opts = computeSnoozeOptions({ now: now ?? new Date(), isAllDay })

  return (
    <CalendarCardSection
      data-testid="task-popover-move"
      className="flex flex-wrap items-center gap-1.5 px-3.5 py-2.5"
    >
      <span className="pe-1 text-xs text-muted-foreground">{t('task-popover.move')}</span>
      {opts.laterToday && (
        <button
          type="button"
          className={MOVE_BUTTON_CLASS}
          title={formatTarget(opts.laterToday)}
          onClick={() => onSnooze(opts.laterToday!)}
        >
          {t('task-popover.later')}
        </button>
      )}
      <button
        type="button"
        className={MOVE_BUTTON_CLASS}
        title={formatTarget(opts.tomorrow)}
        onClick={() => onSnooze(opts.tomorrow)}
      >
        {t('task-popover.tomorrow')}
      </button>
      <button
        type="button"
        className={MOVE_BUTTON_CLASS}
        title={formatTarget(opts.nextWeek)}
        onClick={() => onSnooze(opts.nextWeek)}
      >
        {t('task-popover.next-week')}
      </button>
    </CalendarCardSection>
  )
}

export interface CalendarTaskPopoverMenuProps {
  isCompleted: boolean
  sourceNoteId: string | null
  onOpenSourceNote: () => void
  onPickDateTime: () => void
  onRemoveDueDate: () => void
}

/** The less common task actions, behind the header's overflow button. */
export function CalendarTaskPopoverMenu({
  isCompleted,
  sourceNoteId,
  onOpenSourceNote,
  onPickDateTime,
  onRemoveDueDate
}: CalendarTaskPopoverMenuProps): React.JSX.Element {
  const { t } = useT('calendar')
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={CARD_ICON_BUTTON_CLASS}
          aria-label={t('task-popover.more-actions')}
          title={t('task-popover.more-actions')}
        >
          <MoreHorizontal className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {sourceNoteId && (
          <DropdownMenuItem onClick={onOpenSourceNote}>
            <FileText className="size-3.5" />
            {t('task-popover.source-note')}
          </DropdownMenuItem>
        )}
        {!isCompleted && (
          <>
            {sourceNoteId && <DropdownMenuSeparator />}
            <DropdownMenuItem onClick={onPickDateTime}>
              <CalendarClock className="size-3.5" />
              {t('task-popover.pick-date-time')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onRemoveDueDate}>
              <X className="size-3.5" />
              {t('task-popover.remove-due-date')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export interface CalendarTaskPopoverActionBarProps {
  isCompleted: boolean
  onToggleComplete: () => void
  onOpenTask: () => void
}

export function CalendarTaskPopoverActionBar({
  isCompleted,
  onToggleComplete,
  onOpenTask
}: CalendarTaskPopoverActionBarProps): React.JSX.Element {
  const { t } = useT('calendar')
  return (
    <CalendarCardActionBar
      start={
        <CalendarCardAction
          emphasis
          label={isCompleted ? t('task-popover.mark-not-done') : t('task-popover.complete')}
          keys={[MOD_KEY_LABEL, '↵']}
          onClick={onToggleComplete}
        />
      }
      end={<CalendarCardAction label={t('task-popover.open')} keys={['↵']} onClick={onOpenTask} />}
    />
  )
}

function formatTarget(target: SnoozeTarget): string {
  const [y, m, d] = target.dueDate.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  if (target.dueTime) {
    const [h, min] = target.dueTime.split(':').map(Number)
    date.setHours(h, min, 0, 0)
    return date.toLocaleString(getActiveLocale(), {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit'
    })
  }
  return date.toLocaleDateString(getActiveLocale(), {
    weekday: 'short',
    month: 'short',
    day: 'numeric'
  })
}
