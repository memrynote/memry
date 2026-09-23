import { useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import { StatusIcon } from '@/components/tasks/status-icon'
import { priorityConfig } from '@/data/task-model'
import { CalendarDays, ChevronDown, Flag, Plus } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { ChipBar, ChipCheckbox, eventBarVars, taskBarVars } from './timeline-chip'
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
              backgroundColor: `color-mix(in srgb, ${group.color} 35%, transparent)`
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
  onToggleComplete: () => void
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
          'h-3 w-1 rounded-full bg-background shadow-[0_0_0_1px_var(--chip-rail)] transition-opacity duration-100',
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
  onToggleComplete,
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
  const solid = isSelected || isDragging
  const vars = taskBarVars(color)
  const geometry = { window, dayWidth }
  const trackWidth = window.dayCount * dayWidth
  const completeLabel = t('chip.complete-task', { title: task.title })

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
    'min-w-0 truncate text-xs leading-4 font-semibold',
    isCompleted && !solid && 'text-muted-foreground line-through'
  )

  let visual: React.ReactNode = null
  let outsideLabelAt: number | null = null

  if (shape.kind === 'span' && placement) {
    const style = spanStyle(placement, geometry)
    // The checkbox needs its own room, so it counts toward the fit.
    const fits = titleFits(title, Number(style.width) - 16)
    if (!fits) outsideLabelAt = (placement.to + 1) * dayWidth + 6
    visual = (
      <ChipBar
        data-testid="timeline-task-bar"
        data-kind="span"
        data-solid={solid ? 'true' : undefined}
        vars={vars}
        position={style}
        placement={placement}
        solid={solid}
        done={isCompleted}
        onPointerDown={(event) => onBarPointerDown(event, 'move')}
        className="cursor-grab gap-1.5 ps-[11px] pe-2.5 active:cursor-grabbing"
      >
        {!placement.clippedStart && (
          <ResizeHandle
            side="start"
            visible={solid}
            onPointerDown={(event) => onBarPointerDown(event, 'resize-start')}
          />
        )}
        {fits && !isDragging && (
          <ChipCheckbox
            checked={isCompleted}
            solid={solid}
            label={completeLabel}
            onToggle={onToggleComplete}
          />
        )}
        {fits && <span className={barTextClass}>{title}</span>}
        {!placement.clippedEnd && (
          <ResizeHandle
            side="end"
            visible={solid}
            onPointerDown={(event) => onBarPointerDown(event, 'resize-end')}
          />
        )}
      </ChipBar>
    )
  } else if (shape.kind === 'due' && placement) {
    outsideLabelAt = placement.from * dayWidth + dayWidth / 2 + 12
    visual = (
      <div
        data-testid="timeline-task-milestone"
        data-kind="due"
        onPointerDown={(event) => onBarPointerDown(event, 'move')}
        className="absolute top-0 flex h-full cursor-grab items-center justify-center active:cursor-grabbing"
        style={{ ...vars, insetInlineStart: placement.from * dayWidth, width: dayWidth }}
      >
        <span
          className={cn(
            'size-2.5 rotate-45 rounded-[2px] transition-shadow',
            solid ? 'bg-(--chip-solid)' : 'bg-(--chip-rail)',
            solid && 'shadow-[0_0_0_2px_var(--background),0_0_0_3.5px_var(--chip-solid)]',
            isCompleted && !solid && 'opacity-55'
          )}
        />
      </div>
    )
  } else if (shape.kind === 'start' && placement) {
    const style = spanStyle(placement, geometry)
    const fits = titleFits(title, Number(style.width))
    if (!fits) outsideLabelAt = (placement.to + 1) * dayWidth + 6
    visual = (
      <ChipBar
        data-testid="timeline-task-bar"
        data-kind="start"
        vars={vars}
        position={{
          ...style,
          // Fades toward the future (leftward in RTL): the end is not known.
          backgroundImage:
            'linear-gradient(to var(--timeline-fade-to), var(--chip-surface) 35%, transparent)'
        }}
        placement={placement}
        // A fade cannot go solid and keep its title readable, so selection
        // is an outline here instead.
        solid={false}
        done={isCompleted}
        onPointerDown={(event) => onBarPointerDown(event, 'move')}
        className={cn(
          'cursor-grab rounded-e-none bg-transparent! ps-[11px] pe-2.5 active:cursor-grabbing',
          '[--timeline-fade-to:right] rtl:[--timeline-fade-to:left]',
          solid && 'shadow-[inset_0_0_0_1.5px_var(--chip-rail)]'
        )}
      >
        {fits && <span className={barTextClass}>{title}</span>}
      </ChipBar>
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
          className="pointer-events-none absolute top-[5px] flex h-[22px] items-center justify-center rounded-[6px] border border-dashed border-(--chip-rail)/60 text-(--chip-rail)"
          style={{
            ...vars,
            insetInlineStart: offset * dayWidth + 2,
            width: Math.max(dayWidth - 4, 18)
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
          <button
            type="button"
            role="checkbox"
            aria-checked={isCompleted}
            aria-label={completeLabel}
            className="relative flex shrink-0 cursor-pointer justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-(--tint-ring)"
            style={{ width: 14, marginInlineStart: row.depth === 1 ? 58 : 42 }}
            onPointerDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              onToggleComplete()
            }}
          >
            <StatusIcon
              type={row.statusType}
              color={row.statusType === 'todo' ? 'var(--color-text-tertiary)' : row.statusColor}
            />
          </button>
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
  const { item, placement } = row
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
  const vars = eventBarVars(row)
  const style = placement ? spanStyle(placement, { window, dayWidth }) : null
  const fits = style ? titleFits(item.title, Number(style.width) - 8) : false

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
            style={{ ...vars, width: 14, marginInlineStart: 42 }}
          >
            <span className="h-3.5 w-[3px] rounded-full bg-(--chip-rail)" />
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
            <ChipBar
              data-testid="timeline-event-bar"
              data-solid={isSelected ? 'true' : undefined}
              vars={vars}
              position={style}
              placement={placement}
              solid={isSelected}
              className="ps-[11px] pe-2"
            >
              {fits && (
                <span className="min-w-0 truncate text-xs leading-4 font-semibold">
                  {item.title}
                </span>
              )}
            </ChipBar>
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
