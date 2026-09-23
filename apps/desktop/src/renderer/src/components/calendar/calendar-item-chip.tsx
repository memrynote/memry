import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { Check } from '@/lib/icons'
import { calendarColorChipVars } from '@/lib/calendar-colors'
import { eventTypeChipVars } from '@/lib/event-type-colors'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { formatTimeOfDay } from '@/lib/time-format'
import type { ClockFormat } from '@/lib/time-format'
import { cn } from '@/lib/utils'
import type { CalendarProjectionItem } from '@/services/calendar-service'
import { tasksService } from '@/services/tasks-service'
import { formatDurationShort, itemDurationMinutes } from './chip-duration'
import type { AnchorRect } from './types'

const log = createLogger('CalendarItemChip')

/** Shortest timed item that gets a second line for its time and duration. */
const BLOCK_MIN_MINUTES = 45
/** Longest timed item whose title still keeps to a single line. */
const SINGLE_LINE_TITLE_MAX_MINUTES = 90

interface CalendarItemChipProps {
  item: CalendarProjectionItem
  clockFormat?: ClockFormat
  isSelected?: boolean
  /**
   * `block` is a timed chip in a day/week column: tall enough items stack the
   * time and duration under the title. `inline` (month cells, all-day rows,
   * span bars) keeps everything on one line.
   */
  layout?: 'inline' | 'block'
  /** Clock used to fade events that have already ended. Defaults to the current time. */
  now?: Date
  onClick?: (item: CalendarProjectionItem, rect: AnchorRect) => void
  onDeleteItem?: (item: CalendarProjectionItem) => void
  onAddToProject?: (eventId: string) => void
}

function canDeleteEvent(item: CalendarProjectionItem): boolean {
  return item.sourceType === 'event' && item.editability.canDelete
}

function canAddEventToProject(item: CalendarProjectionItem): boolean {
  return item.sourceType === 'event'
}

function hasEnded(item: CalendarProjectionItem, now: Date): boolean {
  // Only timed events fade. A past-due task still needs doing, and all-day
  // items are stored at UTC midnight, so "ended" would drift by the offset.
  if (item.isAllDay) return false
  if (item.sourceType !== 'event' && item.sourceType !== 'external_event') return false
  const end = new Date(item.endAt ?? item.startAt).getTime()
  return Number.isFinite(end) && end <= now.getTime()
}

/** Keeps pointer and key events on the checkbox from starting a chip drag. */
function stopDragStart(event: React.SyntheticEvent): void {
  event.stopPropagation()
}

export function CalendarItemChip({
  item,
  clockFormat = '12h',
  isSelected = false,
  layout = 'inline',
  now,
  onClick,
  onDeleteItem,
  onAddToProject
}: CalendarItemChipProps): React.JSX.Element {
  const { t } = useT('calendar')
  const { t: tCommon } = useT('common')
  const [isCompleting, setIsCompleting] = useState(false)
  const deleteLabel = t('delete-dialog.context-menu-delete-label')
  const addToProjectLabel = t('delete-dialog.context-menu-add-to-project')
  const deletable = Boolean(onDeleteItem) && canDeleteEvent(item)
  const addableToProject = Boolean(onAddToProject) && canAddEventToProject(item)
  const interactive = Boolean(onClick) || deletable
  const showCheckbox = interactive && item.sourceType === 'task'
  const isOutline = item.visualType === 'note_date'
  const displayColor = item.displayColor ?? undefined

  const durationMinutes = itemDurationMinutes(item)
  const isBlock =
    layout === 'block' &&
    !item.isAllDay &&
    durationMinutes !== null &&
    durationMinutes >= BLOCK_MIN_MINUTES
  const startLabel = item.isAllDay
    ? t('time.all-day')
    : formatTimeOfDay(new Date(item.startAt), clockFormat)
  const metaLabel = useMemo(() => {
    if (!isBlock || !item.endAt || durationMinutes === null) return startLabel
    const endLabel = formatTimeOfDay(new Date(item.endAt), clockFormat)
    return `${startLabel} – ${endLabel} · ${formatDurationShort(durationMinutes, t)}`
  }, [isBlock, item.endAt, durationMinutes, startLabel, clockFormat, t])

  const faded = item.isTriggered || (!isSelected && hasEnded(item, now ?? new Date()))
  const chipVars = useMemo(
    () => (displayColor ? calendarColorChipVars(displayColor) : eventTypeChipVars(item.visualType)),
    [displayColor, item.visualType]
  )

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (!deletable && !addableToProject) return
      e.preventDefault()

      const menuItems = [
        ...(addableToProject ? [{ id: 'add-to-project', label: addToProjectLabel }] : []),
        ...(deletable ? [{ id: 'delete', label: deleteLabel, accelerator: 'Backspace' }] : [])
      ]

      void window.api.showContextMenu(menuItems).then((selectedId) => {
        if (selectedId === 'delete' && onDeleteItem) {
          onDeleteItem(item)
        } else if (selectedId === 'add-to-project' && onAddToProject) {
          onAddToProject(item.sourceId)
        }
      })
    },
    [
      item,
      onDeleteItem,
      deletable,
      deleteLabel,
      onAddToProject,
      addableToProject,
      addToProjectLabel
    ]
  )

  const handleComplete = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation()
      if (isCompleting) return
      const taskId = item.sourceId
      setIsCompleting(true)
      tasksService
        .complete({ id: taskId })
        .then(() => {
          toast(t('chip.task-completed'), {
            action: {
              label: tCommon('action.undo'),
              onClick: () => {
                tasksService.uncomplete(taskId).catch((err: unknown) => {
                  log.error('undo complete failed', err)
                })
              }
            }
          })
        })
        .catch((err: unknown) => {
          setIsCompleting(false)
          toast.error(extractErrorMessage(err, t('chip.could-not-complete')))
        })
    },
    [isCompleting, item.sourceId, t, tCommon]
  )

  const title = (
    <span
      className={cn(
        'min-w-0 text-xs font-semibold leading-4',
        isBlock && durationMinutes !== null && durationMinutes > SINGLE_LINE_TITLE_MAX_MINUTES
          ? 'line-clamp-2'
          : 'truncate',
        !isBlock && 'flex-1',
        isCompleting && 'text-muted-foreground line-through'
      )}
    >
      {item.title}
    </span>
  )
  const meta = (
    <span
      className={cn(
        'shrink-0 truncate text-[11px] font-medium leading-[14px] tabular-nums',
        isSelected ? 'text-(--chip-solid-ink) opacity-90' : 'text-(--chip-meta)',
        isCompleting && 'text-muted-foreground',
        // On one line the title wins: the start time only shows once the chip
        // itself is wide enough to carry both without truncating the title.
        !isBlock && 'hidden @min-[10rem]/chip:inline'
      )}
    >
      {metaLabel}
    </span>
  )
  const content = isBlock ? (
    <span className="flex min-w-0 flex-col gap-px">
      {title}
      {meta}
    </span>
  ) : (
    <span className="flex min-w-0 flex-1 items-center gap-1">
      {title}
      {meta}
    </span>
  )

  const faceClass = cn(
    'flex min-w-0 flex-1 text-start outline-none',
    isBlock ? 'items-start py-[3px]' : 'items-center',
    showCheckbox ? 'ps-1.5' : 'ps-[11px]',
    'pe-1.5 @min-[10rem]/chip:pe-2'
  )

  return (
    <div
      className={cn(
        '@container/chip relative flex h-full min-h-[20px] w-full min-w-0 overflow-hidden rounded-[6px]',
        isSelected
          ? 'bg-(--chip-solid) text-(--chip-solid-ink) shadow-sm'
          : 'bg-(--chip-surface) text-(--cal-ink)',
        isOutline && !isSelected && 'border border-dashed border-(--chip-rail)/50 bg-transparent',
        interactive &&
          !isSelected &&
          'transition-[background-color,transform] duration-100 ease-out hover:bg-[color-mix(in_srgb,var(--chip-rail)_12%,var(--chip-surface))] active:scale-[0.98]',
        isOutline &&
          interactive &&
          !isSelected &&
          'hover:bg-[color-mix(in_srgb,var(--chip-rail)_8%,transparent)]',
        interactive && 'has-focus-visible:ring-2 has-focus-visible:ring-(--tint-ring)',
        faded && 'opacity-60'
      )}
      style={chipVars}
      onContextMenu={deletable || addableToProject ? handleContextMenu : undefined}
      data-visual-type={item.visualType}
      data-event-color={displayColor}
      data-selected={isSelected ? 'true' : undefined}
      data-triggered={item.isTriggered ? 'true' : undefined}
      data-ended={faded && !item.isTriggered ? 'true' : undefined}
    >
      <span
        aria-hidden
        data-chip-rail
        className={cn(
          'pointer-events-none absolute inset-y-[3px] start-[3px] w-[3px] rounded-full',
          isSelected
            ? 'bg-[color-mix(in_srgb,var(--chip-solid-ink)_55%,transparent)]'
            : 'bg-(--chip-rail)'
        )}
      />
      {showCheckbox && (
        <button
          type="button"
          role="checkbox"
          aria-checked={isCompleting}
          aria-label={t('chip.complete-task', { title: item.title })}
          disabled={isCompleting}
          data-testid="calendar-chip-complete"
          className={cn(
            'flex shrink-0 cursor-pointer ps-[11px] outline-none',
            isBlock ? 'items-start pt-[5px]' : 'items-center'
          )}
          onPointerDown={stopDragStart}
          onMouseDown={stopDragStart}
          onKeyDown={stopDragStart}
          onClick={handleComplete}
        >
          <span
            className={cn(
              'grid size-3 place-content-center rounded-[4px] border-[1.5px]',
              isSelected ? 'border-(--chip-solid-ink)' : 'border-(--chip-rail)',
              isCompleting && 'border-(--chip-rail) bg-(--chip-rail) text-white'
            )}
          >
            {isCompleting && <Check className="size-2.5" />}
          </span>
        </button>
      )}
      {interactive ? (
        <button
          type="button"
          className={cn(faceClass, 'cursor-pointer')}
          onClick={(event) => {
            const root = event.currentTarget.closest('[data-visual-type]') ?? event.currentTarget
            const rect = root.getBoundingClientRect()
            onClick?.(item, {
              x: rect.left,
              y: rect.top,
              width: rect.width,
              height: rect.height
            })
          }}
        >
          {content}
        </button>
      ) : (
        <div className={faceClass}>{content}</div>
      )}
    </div>
  )
}

export default CalendarItemChip
