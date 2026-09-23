import { useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import { StatusIcon } from '@/components/tasks/status-icon'
import { priorityConfig } from '@/data/task-model'
import { CalendarDays, ChevronDown, Flag, Plus } from '@/lib/icons'
import { withAlpha } from '@/lib/color'
import { cn } from '@/lib/utils'
import { parseLocalDate } from './date-utils'
import { TIMELINE_LIST_WIDTH } from './timeline-axis'
import {
  dayOffset,
  inclusiveDays,
  placeInWindow,
  shapeBounds,
  toTimelineShape,
  type TimelineDates,
  type TimelineEdit,
  type TimelineEventRow,
  type TimelineGroup,
  type TimelinePlacement,
  type TimelineShape,
  type TimelineTaskRow,
  type TimelineWindow
} from './timeline-model'

export const TIMELINE_ROW_HEIGHT = 32

/** `YYYY-MM-DD` to a short label; the year is added only when it is not this one. */
export type DayFormatter = (date: string) => string

export function useDayFormatter(today: string): DayFormatter {
  const { i18n } = useT('calendar')
  const thisYear = today.slice(0, 4)
  const short = new Intl.DateTimeFormat(i18n.language, { month: 'short', day: 'numeric' })
  const long = new Intl.DateTimeFormat(i18n.language, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })
  return (date) => (date.startsWith(thisYear) ? short : long).format(parseLocalDate(date))
}

export function useDescribeShape(
  formatDay: DayFormatter
): (shape: TimelineShape, isOverdue?: boolean) => string {
  const { t } = useT('calendar')
  return (shape, isOverdue = false) => {
    const base = (() => {
      switch (shape.kind) {
        case 'span':
          return t('timeline.span', {
            start: formatDay(shape.start),
            end: formatDay(shape.end),
            count: inclusiveDays(shape.start, shape.end)
          })
        case 'due':
          return t('timeline.due', { date: formatDay(shape.date) })
        case 'start':
          return t('timeline.starts', { date: formatDay(shape.date) })
        case 'none':
          return t('timeline.no-date')
      }
    })()
    return isOverdue ? `${base}, ${t('timeline.overdue')}` : base
  }
}

// Rough glyph width for 12px medium text. Only decides whether a title fits
// inside its bar or goes beside it, so it errs wide.
const TITLE_CHAR_PX = 6.8
const BAR_PADDING_PX = 20

function titleFits(title: string, widthPx: number): boolean {
  return title.length * TITLE_CHAR_PX + BAR_PADDING_PX <= widthPx
}

interface Geometry {
  window: TimelineWindow
  dayWidth: number
}

function spanStyle(placement: TimelinePlacement, { dayWidth }: Geometry): React.CSSProperties {
  const inset = 2
  return {
    insetInlineStart: placement.from * dayWidth + (placement.clippedStart ? 0 : inset),
    width:
      (placement.to - placement.from + 1) * dayWidth -
      (placement.clippedStart ? 0 : inset) -
      (placement.clippedEnd ? 0 : inset)
  }
}

// ---------------------------------------------------------------------------
// Group header
// ---------------------------------------------------------------------------

interface GroupHeaderProps extends Geometry {
  group: TimelineGroup
  collapsed: boolean
  onToggle: () => void
}

export function TimelineGroupHeader({
  group,
  collapsed,
  onToggle,
  window,
  dayWidth
}: GroupHeaderProps): React.JSX.Element | null {
  const { t } = useT('calendar')
  const { heading } = group
  if (heading.kind === 'all') return null

  const label =
    heading.kind === 'project'
      ? heading.name
      : heading.kind === 'events'
        ? t('timeline.events')
        : heading.kind === 'status'
          ? t(`timeline.status.${heading.status}`)
          : t(`timeline.priority.${heading.priority}`)

  const mark =
    heading.kind === 'project' ? (
      <span
        className="size-2 rounded-[2px]"
        style={{ backgroundColor: group.color ?? undefined }}
      />
    ) : heading.kind === 'events' ? (
      <CalendarDays className="size-3.5 text-text-tertiary" />
    ) : heading.kind === 'status' ? (
      <StatusIcon
        type={heading.status}
        color={
          heading.status === 'done'
            ? 'var(--color-task-complete)'
            : heading.status === 'in_progress'
              ? 'var(--color-task-priority-medium)'
              : 'var(--color-text-tertiary)'
        }
        size="sm"
      />
    ) : (
      <Flag
        className="size-3.5"
        style={{ color: priorityConfig[heading.priority].color ?? undefined }}
      />
    )

  return (
    <div role="row" className="flex h-10 pt-2" data-testid="timeline-group">
      <div
        role="rowheader"
        className="sticky start-0 z-10 flex shrink-0 items-center gap-2 border-e border-border bg-background ps-5 pe-3"
        style={{ width: TIMELINE_LIST_WIDTH }}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          className={cn(
            '-ms-1 flex min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-start',
            'hover:bg-surface-active/60 focus-visible:outline-2 focus-visible:outline-ring'
          )}
        >
          <ChevronDown
            aria-hidden="true"
            className={cn(
              'size-3 shrink-0 text-text-tertiary transition-transform duration-150 ease-out',
              collapsed && '-rotate-90 rtl:rotate-90'
            )}
          />
          <span aria-hidden="true" className="flex w-3.5 shrink-0 justify-center">
            {mark}
          </span>
          <h3 className="truncate text-[13px] font-semibold text-foreground">{label}</h3>
          <span className="shrink-0 text-xs text-text-tertiary tabular-nums">
            {group.rows.length}
          </span>
        </button>
      </div>
      <div className="relative shrink-0" style={{ width: window.dayCount * dayWidth }}>
        {group.summary && group.color && (
          <div
            aria-hidden="true"
            data-testid="timeline-group-summary"
            className={cn(
              'absolute top-3.5 h-1 rounded-full',
              group.summary.clippedStart && 'rounded-s-none',
              group.summary.clippedEnd && 'rounded-e-none'
            )}
            style={{
              ...spanStyle(group.summary, { window, dayWidth }),
              backgroundColor: withAlpha(group.color, 0.3)
            }}
          />
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared row chrome
// ---------------------------------------------------------------------------

interface RowFrameProps {
  id: string
  isSelected: boolean
  label: string
  testId: string
  onSelect: () => void
  onOpen: (rect: DOMRect) => void
  listCell: React.ReactNode
  trackWidth: number
  track: React.ReactNode
  trackProps?: Omit<React.HTMLAttributes<HTMLDivElement>, 'className'>
  trackClassName?: string
}

function RowFrame({
  id,
  isSelected,
  label,
  testId,
  onSelect,
  onOpen,
  listCell,
  trackWidth,
  track,
  trackProps,
  trackClassName
}: RowFrameProps): React.JSX.Element {
  return (
    <div
      id={id}
      role="row"
      aria-selected={isSelected}
      aria-label={label}
      data-testid={testId}
      className="group/row relative flex"
      style={{ height: TIMELINE_ROW_HEIGHT }}
      onPointerDown={(event) => {
        if (event.button === 0) onSelect()
      }}
      onDoubleClick={(event) => onOpen(event.currentTarget.getBoundingClientRect())}
    >
      <div
        role="gridcell"
        className="sticky start-0 z-10 flex shrink-0 items-center gap-2 border-e border-border bg-background pe-3"
        style={{ width: TIMELINE_LIST_WIDTH }}
      >
        <div
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-0 transition-colors duration-100 ease-out',
            isSelected ? 'bg-foreground/[0.05]' : 'group-hover/row:bg-foreground/[0.025]'
          )}
        />
        {listCell}
      </div>
      <div
        role="gridcell"
        data-timeline-track
        className={cn(
          'relative shrink-0 transition-colors duration-100 ease-out',
          isSelected ? 'bg-foreground/[0.035]' : 'group-hover/row:bg-foreground/[0.02]',
          trackClassName
        )}
        style={{ width: trackWidth }}
        {...trackProps}
      >
        {track}
      </div>
    </div>
  )
}

function DatePill({
  children,
  style
}: {
  children: React.ReactNode
  style: React.CSSProperties
}): React.JSX.Element {
  return (
    <div
      className="pointer-events-none absolute top-[7px] z-10 flex h-[18px] items-center gap-1.5 rounded-[5px] bg-foreground px-1.5 text-[11px] font-medium whitespace-nowrap text-background tabular-nums shadow-sm"
      style={style}
    >
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Task row
// ---------------------------------------------------------------------------

export interface TaskRowProps extends Geometry {
  row: TimelineTaskRow
  domId: string
  today: string
  isSelected: boolean
  /** Dates shown while a drag or schedule gesture is in flight. */
  preview: TimelineDates | null
  formatDay: DayFormatter
  describe: (shape: TimelineShape, isOverdue?: boolean) => string
  onSelect: () => void
  onOpen: (rect: DOMRect) => void
  onBarPointerDown: (event: React.PointerEvent, edit: TimelineEdit) => void
  onSchedulePointerDown: (event: React.PointerEvent) => void
  dayFromPointer: (event: React.PointerEvent) => string | null
}

function previewShape(dates: TimelineDates): TimelineShape {
  return toTimelineShape({
    startDate: dates.startDate ? parseLocalDate(dates.startDate) : null,
    dueDate: dates.dueDate ? parseLocalDate(dates.dueDate) : null
  })
}

function ResizeHandle({
  side,
  visible,
  onPointerDown
}: {
  side: 'start' | 'end'
  visible: boolean
  onPointerDown: (event: React.PointerEvent) => void
}): React.JSX.Element {
  return (
    <div
      data-testid={`timeline-resize-${side}`}
      onPointerDown={onPointerDown}
      className={cn(
        'absolute inset-y-0 z-10 flex w-2.5 cursor-ew-resize items-center justify-center',
        side === 'start' ? 'start-0' : 'end-0'
      )}
    >
      <span
        className={cn(
          'h-3 w-1 rounded-full bg-background shadow-[0_0_0_1px_currentColor] transition-opacity duration-100',
          visible ? 'opacity-100' : 'opacity-0 group-hover/bar:opacity-100'
        )}
      />
    </div>
  )
}

export function TimelineTaskRowView({
  row,
  domId,
  window,
  dayWidth,
  today,
  isSelected,
  preview,
  formatDay,
  describe,
  onSelect,
  onOpen,
  onBarPointerDown,
  onSchedulePointerDown,
  dayFromPointer
}: TaskRowProps): React.JSX.Element {
  const { t } = useT('calendar')
  const [hoverDay, setHoverDay] = useState<string | null>(null)
  const { task, color, isCompleted, isOverdue } = row
  const shape = preview ? previewShape(preview) : row.shape
  const bounds = shapeBounds(shape)
  const placement = bounds ? placeInWindow(bounds.first, bounds.last, window) : null
  const isDragging = preview !== null
  const geometry = { window, dayWidth }
  const trackWidth = window.dayCount * dayWidth

  const lastDay = shape.kind === 'span' ? shape.end : shape.kind === 'due' ? shape.date : null
  const dueIsToday = !isCompleted && lastDay === today
  const meta =
    shape.kind === 'none'
      ? t('timeline.no-date')
      : shape.kind === 'start'
        ? t('timeline.starts-short', { date: formatDay(shape.date) })
        : dueIsToday
          ? t('timeline.today')
          : formatDay(lastDay ?? '')

  const title = task.title || t('timeline.untitled')
  const barTextClass = cn(
    'truncate text-xs font-medium text-foreground',
    isCompleted && 'text-text-secondary line-through decoration-text-tertiary'
  )

  let visual: React.ReactNode = null
  let outsideLabelAt: number | null = null

  if (shape.kind === 'span' && placement) {
    const style = spanStyle(placement, geometry)
    const fits = titleFits(title, Number(style.width))
    if (!fits) outsideLabelAt = (placement.to + 1) * dayWidth + 6
    visual = (
      <div
        data-testid="timeline-task-bar"
        data-kind="span"
        onPointerDown={(event) => onBarPointerDown(event, 'move')}
        className={cn(
          'group/bar absolute top-[5px] flex h-[22px] cursor-grab items-center rounded-md px-2.5 active:cursor-grabbing',
          placement.clippedStart && 'rounded-s-none',
          placement.clippedEnd && 'rounded-e-none',
          isCompleted && 'opacity-55'
        )}
        style={{
          ...style,
          color,
          backgroundColor: withAlpha(color, isSelected || isDragging ? 0.24 : 0.15),
          boxShadow: `inset 0 0 0 ${isSelected || isDragging ? 1.5 : 1}px ${withAlpha(
            color,
            isSelected || isDragging ? 0.9 : 0.28
          )}`
        }}
      >
        {!placement.clippedStart && (
          <ResizeHandle
            side="start"
            visible={isSelected || isDragging}
            onPointerDown={(event) => onBarPointerDown(event, 'resize-start')}
          />
        )}
        {fits && <span className={barTextClass}>{title}</span>}
        {!placement.clippedEnd && (
          <ResizeHandle
            side="end"
            visible={isSelected || isDragging}
            onPointerDown={(event) => onBarPointerDown(event, 'resize-end')}
          />
        )}
      </div>
    )
  } else if (shape.kind === 'due' && placement) {
    outsideLabelAt = placement.from * dayWidth + dayWidth / 2 + 12
    visual = (
      <div
        data-testid="timeline-task-milestone"
        data-kind="due"
        onPointerDown={(event) => onBarPointerDown(event, 'move')}
        className="absolute top-0 flex h-full cursor-grab items-center justify-center active:cursor-grabbing"
        style={{ insetInlineStart: placement.from * dayWidth, width: dayWidth }}
      >
        <span
          className={cn(
            'size-2.5 rotate-45 rounded-[2px] transition-shadow',
            isCompleted && 'opacity-55'
          )}
          style={{
            backgroundColor: color,
            boxShadow:
              isSelected || isDragging
                ? `0 0 0 2px var(--color-background), 0 0 0 3.5px ${color}`
                : undefined
          }}
        />
      </div>
    )
  } else if (shape.kind === 'start' && placement) {
    const style = spanStyle(placement, geometry)
    const fits = titleFits(title, Number(style.width))
    if (!fits) outsideLabelAt = (placement.to + 1) * dayWidth + 6
    visual = (
      <div
        data-testid="timeline-task-bar"
        data-kind="start"
        onPointerDown={(event) => onBarPointerDown(event, 'move')}
        className={cn(
          'absolute top-[5px] flex h-[22px] cursor-grab items-center overflow-hidden rounded-s-md px-2.5 active:cursor-grabbing',
          // The fade runs toward the future, which is left in RTL.
          '[--timeline-fade-to:right] rtl:[--timeline-fade-to:left]',
          isCompleted && 'opacity-55'
        )}
        style={{
          ...style,
          backgroundImage: `linear-gradient(to var(--timeline-fade-to), ${withAlpha(
            color,
            isSelected || isDragging ? 0.3 : 0.2
          )}, ${withAlpha(color, 0)})`
        }}
      >
        {!placement.clippedStart && (
          <span
            aria-hidden="true"
            className="absolute inset-y-0 start-0 w-0.5"
            style={{ backgroundColor: color }}
          />
        )}
        {fits && <span className={barTextClass}>{title}</span>}
      </div>
    )
  }

  // The slip line: from where an overdue task should have ended to today.
  let slip: React.ReactNode = null
  if (isOverdue && !isDragging && lastDay) {
    const todayOffset = dayOffset(today, window)
    const endOffset = dayOffset(lastDay, window)
    const from = Math.max(0, (endOffset + 1) * dayWidth)
    const to = Math.min(trackWidth, todayOffset * dayWidth + dayWidth / 2)
    if (to > from) {
      slip = (
        <div
          aria-hidden="true"
          data-testid="timeline-slip"
          className="pointer-events-none absolute top-[15px] border-t-[1.5px] border-dashed border-task-due-overdue/60"
          style={{ insetInlineStart: from, width: to - from }}
        />
      )
    }
  }

  // Unscheduled rows: a ghost follows the pointer; click or drag to schedule.
  let ghost: React.ReactNode = null
  if (shape.kind === 'none' && hoverDay && !isDragging) {
    const offset = dayOffset(hoverDay, window)
    ghost = (
      <>
        <div
          aria-hidden="true"
          data-testid="timeline-schedule-ghost"
          className="pointer-events-none absolute top-[5px] flex h-[22px] items-center justify-center rounded-md border border-dashed"
          style={{
            insetInlineStart: offset * dayWidth + 2,
            width: Math.max(dayWidth - 4, 18),
            borderColor: withAlpha(color, 0.6),
            color
          }}
        >
          <Plus className="size-3" />
        </div>
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-2 text-xs whitespace-nowrap text-text-tertiary"
          style={{ insetInlineStart: offset * dayWidth + Math.max(dayWidth, 22) + 6 }}
        >
          {t('timeline.schedule-hint')}
        </span>
      </>
    )
  }

  // While dragging, or when selected, name the dates at both ends.
  let pills: React.ReactNode = null
  if ((isSelected || isDragging) && placement && shape.kind !== 'none') {
    const firstDay = shape.kind === 'span' ? shape.start : shape.date
    const endDay = shape.kind === 'span' ? shape.end : null
    const startEdge = placement.from * dayWidth
    const endEdge = (placement.to + 1) * dayWidth
    if (shape.kind === 'span') {
      pills = (
        <>
          {!placement.clippedStart && (
            <DatePill style={{ insetInlineEnd: trackWidth - startEdge + 6 }}>
              {formatDay(firstDay)}
            </DatePill>
          )}
          {!placement.clippedEnd && endDay && (
            <DatePill style={{ insetInlineStart: endEdge + 6 }}>
              {formatDay(endDay)}
              <span className="font-normal opacity-60">
                {t('timeline.days', { count: inclusiveDays(firstDay, endDay) })}
              </span>
            </DatePill>
          )}
        </>
      )
      outsideLabelAt = null
    } else if (isDragging) {
      pills = <DatePill style={{ insetInlineStart: endEdge + 6 }}>{formatDay(firstDay)}</DatePill>
      outsideLabelAt = null
    }
  }

  const isScheduling = preview !== null && row.shape.kind === 'none'

  return (
    <RowFrame
      id={domId}
      isSelected={isSelected}
      label={`${title}, ${describe(row.shape, isOverdue)}`}
      testId="timeline-task-row"
      onSelect={onSelect}
      onOpen={onOpen}
      trackWidth={trackWidth}
      listCell={
        <>
          <span
            className="relative flex shrink-0 justify-center"
            style={{ width: 14, marginInlineStart: row.depth === 1 ? 58 : 42 }}
          >
            <StatusIcon
              type={row.statusType}
              color={row.statusType === 'todo' ? 'var(--color-text-tertiary)' : row.statusColor}
            />
          </span>
          <span
            className={cn(
              'relative min-w-0 flex-1 truncate text-[13px] text-foreground',
              isCompleted && 'text-text-tertiary line-through'
            )}
          >
            {title}
          </span>
          <span
            className={cn(
              'relative w-16 shrink-0 text-end text-xs whitespace-nowrap tabular-nums',
              shape.kind === 'none'
                ? 'text-text-tertiary/80'
                : isOverdue
                  ? 'text-task-due-overdue'
                  : dueIsToday
                    ? 'text-task-due-today'
                    : 'text-text-tertiary'
            )}
          >
            {meta}
          </span>
        </>
      }
      trackProps={
        row.shape.kind === 'none'
          ? {
              onPointerMove: (event) => setHoverDay(dayFromPointer(event)),
              onPointerLeave: () => setHoverDay(null),
              onPointerDown: (event) => {
                if (event.button !== 0) return
                onSelect()
                onSchedulePointerDown(event)
              }
            }
          : undefined
      }
      trackClassName={row.shape.kind === 'none' ? 'cursor-copy' : undefined}
      track={
        <>
          {slip}
          {visual}
          {outsideLabelAt !== null && (
            <span
              className={cn(
                'pointer-events-none absolute top-2 text-xs whitespace-nowrap text-text-secondary',
                isCompleted && 'line-through'
              )}
              style={{ insetInlineStart: outsideLabelAt }}
            >
              {title}
            </span>
          )}
          {pills}
          {ghost}
          {isScheduling && <span className="sr-only">{t('timeline.schedule-hint')}</span>}
        </>
      }
    />
  )
}

// ---------------------------------------------------------------------------
// Event row
// ---------------------------------------------------------------------------

export interface EventRowProps extends Geometry {
  row: TimelineEventRow
  domId: string
  isSelected: boolean
  formatDay: DayFormatter
  onSelect: () => void
  onOpen: (rect: DOMRect) => void
}

export function TimelineEventRowView({
  row,
  domId,
  window,
  dayWidth,
  isSelected,
  formatDay,
  onSelect,
  onOpen
}: EventRowProps): React.JSX.Element {
  const { t } = useT('calendar')
  const { item, placement, color } = row
  const isImported = item.source.provider !== null && !item.source.isMemryManaged
  const range =
    row.start === row.end
      ? formatDay(row.start)
      : t('timeline.span', {
          start: formatDay(row.start),
          end: formatDay(row.end),
          count: inclusiveDays(row.start, row.end)
        })
  const trackWidth = window.dayCount * dayWidth
  const style = placement ? spanStyle(placement, { window, dayWidth }) : null
  const fits = style ? titleFits(item.title, Number(style.width) - 3) : false

  return (
    <RowFrame
      id={domId}
      isSelected={isSelected}
      label={`${item.title}, ${range}`}
      testId="timeline-event-row"
      onSelect={onSelect}
      onOpen={onOpen}
      trackWidth={trackWidth}
      listCell={
        <>
          <span
            className="relative flex shrink-0 justify-center"
            style={{ width: 14, marginInlineStart: 42 }}
          >
            <span className="h-3.5 w-[3px] rounded-full" style={{ backgroundColor: color }} />
          </span>
          <span className="relative min-w-0 flex-1 truncate text-[13px] text-foreground">
            {item.title}
          </span>
          {isImported && item.source.title && (
            <span className="relative max-w-20 shrink-0 truncate rounded bg-surface-active px-1.5 text-[10px] leading-4 font-medium text-text-secondary">
              {item.source.title}
            </span>
          )}
          <span className="relative shrink-0 text-end text-xs whitespace-nowrap text-text-tertiary tabular-nums">
            {range}
          </span>
        </>
      }
      track={
        placement &&
        style && (
          <>
            <div
              data-testid="timeline-event-bar"
              className={cn(
                'absolute top-[5px] flex h-[22px] overflow-hidden rounded',
                placement.clippedStart && 'rounded-s-none',
                placement.clippedEnd && 'rounded-e-none'
              )}
              style={{
                ...style,
                backgroundColor: withAlpha(color, isSelected ? 0.3 : 0.18),
                boxShadow: isSelected ? `inset 0 0 0 1.5px ${color}` : undefined
              }}
            >
              {!placement.clippedStart && (
                <span className="w-[3px] shrink-0" style={{ backgroundColor: color }} />
              )}
              {fits && (
                <span className="truncate px-2 text-xs leading-[22px] font-medium text-foreground">
                  {item.title}
                </span>
              )}
            </div>
            {!fits && (
              <span
                className="pointer-events-none absolute top-2 text-xs whitespace-nowrap text-text-secondary"
                style={{ insetInlineStart: (placement.to + 1) * dayWidth + 6 }}
              >
                {item.title}
              </span>
            )}
          </>
        )
      }
    />
  )
}
