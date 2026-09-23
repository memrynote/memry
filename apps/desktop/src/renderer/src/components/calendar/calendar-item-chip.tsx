import { useCallback, useMemo } from 'react'
import { useT } from '@memry/i18n/renderer'
import { AlarmClock, Calendar2, CheckSquare3, NotificationSnooze, StickyNote } from '@/lib/icons'
import { calendarColorChipStyle, inkOnCalendarColor } from '@/lib/calendar-colors'
import { getEventBaseColor, getEventBgColor, getEventTextColor } from '@/lib/event-type-colors'
import { formatTimeOfDay, formatTimeRange } from '@/lib/time-format'
import type { ClockFormat } from '@/lib/time-format'
import { cn } from '@/lib/utils'
import type { CalendarProjectionItem } from '@/services/calendar-service'
import type { AnchorRect } from './types'

const VISUAL_TYPE_ICONS: Record<
  CalendarProjectionItem['visualType'],
  React.ComponentType<{ className?: string }>
> = {
  event: Calendar2,
  task: CheckSquare3,
  reminder: AlarmClock,
  snooze: NotificationSnooze,
  external_event: Calendar2,
  note: StickyNote,
  note_date: StickyNote
}

/**
 * `inline` is one line: title and start time side by side (month cells, all-day
 * strips). `block` is a time-grid block: the title, then the time range under it,
 * clipped away when the block is too short to hold a second line.
 */
export type CalendarItemChipLayout = 'inline' | 'block'

/**
 * `fill` is the Calendar page's tinted chip. `bar` and `pill` are the Day Panel's
 * quieter forms: a block with a colored leading bar, and an all-day pill with a
 * colored dot. Both keep the text in ink and let the color mark the type only.
 */
export type CalendarItemChipAppearance = 'fill' | 'bar' | 'pill'

export interface CalendarItemChipProps {
  item: CalendarProjectionItem
  clockFormat?: ClockFormat
  layout?: CalendarItemChipLayout
  appearance?: CalendarItemChipAppearance
  isSelected?: boolean
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

function timeRangeLabel(item: CalendarProjectionItem, clockFormat: ClockFormat): string {
  const start = new Date(item.startAt)
  return item.endAt
    ? formatTimeRange(start, new Date(item.endAt), clockFormat)
    : formatTimeOfDay(start, clockFormat)
}

/** The type color at 12% over the canvas: opaque, so grid lines stay behind it. */
function quietBackground(color: string): string {
  return `color-mix(in srgb, ${color} 12%, var(--background))`
}

export function CalendarItemChip({
  item,
  clockFormat = '12h',
  layout = 'inline',
  appearance = 'fill',
  isSelected = false,
  onClick,
  onDeleteItem,
  onAddToProject
}: CalendarItemChipProps): React.JSX.Element {
  const { t } = useT('calendar')
  const deleteLabel = t('delete-dialog.context-menu-delete-label')
  const addToProjectLabel = t('delete-dialog.context-menu-add-to-project')
  const timeLabel = item.isAllDay
    ? t('time.all-day')
    : formatTimeOfDay(new Date(item.startAt), clockFormat)
  const VisualIcon = VISUAL_TYPE_ICONS[item.visualType]
  const deletable = Boolean(onDeleteItem) && canDeleteEvent(item)
  const addableToProject = Boolean(onAddToProject) && canAddEventToProject(item)
  const isBlock = layout === 'block'
  const displayColor = item.displayColor ?? undefined
  // A calendar's own colour (Google palette, custom) wins over the type colour.
  const baseColor = displayColor ?? getEventBaseColor(item.visualType)
  const selectedInk = displayColor ? inkOnCalendarColor(displayColor) : '#FFFFFF'
  const cls = cn(
    appearance === 'pill'
      ? 'inline-flex h-[22px] max-w-full items-center gap-1.5 rounded-[5px] ps-[7px] pe-2 text-start'
      : appearance === 'bar'
        ? 'flex h-full w-full flex-col items-stretch gap-px overflow-hidden rounded-[4px] border-s-[3px] px-2 py-1 text-start'
        : isBlock
          ? 'flex h-full w-full flex-col items-stretch overflow-hidden rounded-[6px] px-1 py-0.5 text-start @xl:px-2 @xl:py-1'
          : 'flex h-full w-full items-start justify-between gap-0.5 rounded-[6px] px-1 py-0.5 text-start @xl:px-2 @xl:py-1',
    'transition-[filter,transform] duration-100 ease-out',
    (onClick || deletable) &&
      'cursor-pointer hover:brightness-[1.06] active:scale-[0.98] active:brightness-[0.97]',
    // Fired note_date chips are kept but faded so the date isn't lost.
    item.isTriggered && 'opacity-60'
  )
  const chipStyle = useMemo<React.CSSProperties>(() => {
    if (appearance !== 'fill') {
      return isSelected
        ? { backgroundColor: baseColor, borderColor: baseColor, color: selectedInk }
        : { backgroundColor: quietBackground(baseColor), borderColor: baseColor }
    }
    if (displayColor) return calendarColorChipStyle(displayColor, isSelected)
    return isSelected
      ? { backgroundColor: baseColor, color: '#FFFFFF' }
      : {
          backgroundColor: getEventBgColor(item.visualType),
          color: getEventTextColor(item.visualType)
        }
  }, [appearance, baseColor, displayColor, isSelected, item.visualType, selectedInk])

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

  const content =
    appearance === 'pill' ? (
      <>
        <span
          aria-hidden="true"
          className="size-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: isSelected ? selectedInk : baseColor }}
        />
        <span
          className={cn(
            'min-w-0 truncate text-xs font-medium leading-4',
            !isSelected && 'text-foreground'
          )}
        >
          {item.title}
        </span>
      </>
    ) : appearance === 'bar' ? (
      <>
        <span className="flex min-w-0 items-center gap-[5px]">
          {item.sourceType === 'task' && (
            <span
              aria-hidden="true"
              className="size-[11px] shrink-0 rounded-full border-[1.5px]"
              style={{ borderColor: isSelected ? selectedInk : baseColor }}
            />
          )}
          <span
            className={cn(
              'min-w-0 truncate text-xs font-medium leading-4',
              !isSelected && 'text-foreground'
            )}
          >
            {item.title}
          </span>
        </span>
        <span
          className={cn(
            'truncate text-[11px] leading-[14px] tabular-nums',
            isSelected ? 'opacity-80' : 'text-muted-foreground'
          )}
        >
          {timeRangeLabel(item, clockFormat)}
        </span>
      </>
    ) : isBlock ? (
      <>
        <span className="flex min-w-0 items-start gap-0.5">
          <VisualIcon className="mt-0.5 size-3 shrink-0" />
          <span className="flex-1 truncate text-xs font-semibold leading-[18px]">{item.title}</span>
        </span>
        <span className="truncate text-[11px] leading-[14px] tabular-nums opacity-75">
          {timeRangeLabel(item, clockFormat)}
        </span>
      </>
    ) : (
      <>
        <VisualIcon className="mt-0.5 size-3 shrink-0" />
        <span className="flex-1 truncate text-xs font-semibold leading-[18px]">{item.title}</span>
        <span className="hidden shrink-0 text-xs leading-[18px] opacity-75 @xl:inline">
          {timeLabel}
        </span>
      </>
    )

  if (onClick || deletable) {
    return (
      <button
        type="button"
        className={cls}
        style={chipStyle}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          onClick?.(item, {
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height
          })
        }}
        onContextMenu={deletable || addableToProject ? handleContextMenu : undefined}
        data-visual-type={item.visualType}
        data-event-color={displayColor}
        data-triggered={item.isTriggered ? 'true' : undefined}
      >
        {content}
      </button>
    )
  }

  return (
    <div
      className={cls}
      style={chipStyle}
      data-visual-type={item.visualType}
      data-event-color={displayColor}
      data-triggered={item.isTriggered ? 'true' : undefined}
    >
      {content}
    </div>
  )
}

export default CalendarItemChip
