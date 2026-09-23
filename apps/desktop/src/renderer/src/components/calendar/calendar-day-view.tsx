import { useCallback, useMemo, useRef } from 'react'
import { useT } from '@memry/i18n/renderer'
import { CalendarAllDayCell } from './calendar-allday-cell'
import { CalendarItemChip } from './calendar-item-chip'
import { CalendarTimedColumnDroppable } from './calendar-timed-column-droppable'
import { DraggableTaskChip } from './draggable-task-chip'
import { isMultiDaySpan, isToday, spanCoversDate } from './date-utils'
import { assignLanes } from './overlap-layout'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { formatHour } from '@/lib/time-format'
import { cn } from '@/lib/utils'
import type { CalendarProjectionItem } from '@/services/calendar-service'
import { useTimeGridMarquee } from './use-time-grid-marquee'
import { useEventDrag, isEventMovable, isEventResizable } from './use-event-drag'
import { MarqueeSelectionOverlay } from './marquee-selection-overlay'
import { CalendarQuickCreateDialog } from './calendar-quick-create-dialog'
import { useScrollToCurrentTime } from './use-scroll-to-current-time'
import { useTabScrollRestore } from '@/hooks/use-tab-scroll-restore'
import { CALENDAR_SCROLL_KEYS } from '@/pages/calendar-view-state'
import { useOptionalDragContext } from '@/contexts/drag-context'
import type { AnchorRect, CalendarEventDraft } from './types'
import { HOUR_HEIGHT } from './time-grid-constants'

const HOURS = Array.from({ length: 24 }, (_, i) => i)

/** The Day Panel's timeline: shorter hours, since it shows a window of the day. */
const COMPACT_HOUR_HEIGHT = 40
/** Keeps the first and last hour labels, which sit on their lines, off the scroll edges. */
const COMPACT_GRID_PADDING = 8

function gridLineBackground(hourHeight: number): string {
  return `repeating-linear-gradient(to bottom, transparent, transparent ${hourHeight - 1}px, var(--grid-line-color) ${hourHeight - 1}px, var(--grid-line-color) ${hourHeight}px)`
}

function getEventPosition(item: CalendarProjectionItem, hourHeight: number) {
  const start = new Date(item.startAt)
  const top = start.getHours() * hourHeight + start.getMinutes() * (hourHeight / 60)
  const endMs = item.endAt ? new Date(item.endAt).getTime() : start.getTime() + 3600000
  const durationMinutes = (endMs - start.getTime()) / 60000
  return { top, height: Math.max(durationMinutes * (hourHeight / 60), 24) }
}

/**
 * `default` is the Calendar tab's day view. `compact` is the Day Panel's
 * timeline: a fixed-height window over the day, quieter labels and lines, no
 * "All day" label, and a drop preview for tasks dragged in from the panel.
 */
export type CalendarDayViewDensity = 'default' | 'compact'

interface CalendarDayViewProps {
  anchorDate: string
  items: CalendarProjectionItem[]
  selectedItemId: string | null
  onSelectItem?: (item: CalendarProjectionItem, rect: AnchorRect) => void
  onDeleteItem?: (item: CalendarProjectionItem) => void
  onAddToProject?: (eventId: string) => void
  onMoveEvent?: (
    item: CalendarProjectionItem,
    startAt: string,
    endAt: string
  ) => void | Promise<void>
  onQuickSave?: (draft: CalendarEventDraft) => void | Promise<void>
  density?: CalendarDayViewDensity
}

export function CalendarDayView({
  anchorDate,
  items,
  selectedItemId,
  onSelectItem,
  onDeleteItem,
  onAddToProject,
  onMoveEvent,
  onQuickSave,
  density = 'default'
}: CalendarDayViewProps): React.JSX.Element {
  const compact = density === 'compact'
  const hourHeight = compact ? COMPACT_HOUR_HEIGHT : HOUR_HEIGHT
  const gridPadding = compact ? COMPACT_GRID_PADDING : 0
  const {
    settings: { clockFormat }
  } = useGeneralSettings()
  const { t } = useT('calendar')
  const isTaskDragInFlight = useOptionalDragContext()?.dragState.isDragging ?? false
  const gridRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const getScrollEl = useCallback(() => scrollRef.current, [])
  const dateForColumn = useCallback(() => anchorDate, [anchorDate])
  const { selection, isDragging, handlers, clearSelection } = useTimeGridMarquee({
    gridRef,
    scrollRef,
    dateForColumn,
    hourHeight
  })
  const { drag, startMove, startResize, wasDragged } = useEventDrag({
    gridRef,
    dateForColumn,
    hourHeight,
    onCommit: (item, startAt, endAt) => onMoveEvent?.(item, startAt, endAt)
  })
  const handleChipClick = useCallback(
    (item: CalendarProjectionItem, rect: AnchorRect) => {
      if (wasDragged()) return
      onSelectItem?.(item, rect)
    },
    [onSelectItem, wasDragged]
  )
  const today = isToday(anchorDate)
  useScrollToCurrentTime(scrollRef, today, CALENDAR_SCROLL_KEYS.day, hourHeight)
  // Deliberately NOT date-keyed: the offset here is a time of day, and the hour
  // the user reads at is the same hour whatever day they move to.
  useTabScrollRestore({ getScrollElement: getScrollEl, key: CALENDAR_SCROLL_KEYS.day })
  // A span covering this day belongs here even when it started days ago, and it
  // shows in the all-day strip rather than as a huge block in the time grid.
  const dayItems = items.filter((item) => spanCoversDate(item, anchorDate))
  const timedItems = dayItems.filter((item) => !item.isAllDay && !isMultiDaySpan(item))
  const allDayItems = dayItems.filter((item) => item.isAllDay || isMultiDaySpan(item))

  const currentTimeOffset = useMemo(() => {
    const now = new Date()
    return now.getHours() * hourHeight + now.getMinutes() * (hourHeight / 60)
  }, [hourHeight])
  const chipLayout = 'block'
  const chipAppearance = compact ? 'bar' : 'fill'

  return (
    <div
      className={cn('flex flex-col', !compact && 'h-full')}
      data-testid="calendar-view"
      data-view="day"
      data-density={density}
    >
      {(allDayItems.length > 0 || isTaskDragInFlight) && (
        <div
          data-testid="day-all-day-strip"
          className={cn(
            'flex shrink-0 items-center',
            compact ? 'ps-12 pe-4 pb-2.5' : 'gap-2 border-b border-border px-3 py-2'
          )}
        >
          {!compact && (
            <span className="w-[48px] shrink-0 text-xs font-medium text-muted-foreground @xl:w-[72px] pe-3 text-end">
              {t('time.all-day')}
            </span>
          )}
          <CalendarAllDayCell
            date={anchorDate}
            className={cn(
              'flex flex-1 flex-wrap',
              compact ? 'min-h-[22px] gap-1 rounded-[5px]' : 'gap-1.5'
            )}
          >
            {allDayItems.map((item) => (
              <div
                key={item.projectionId}
                className={compact ? 'min-w-0 max-w-full' : 'min-w-[140px]'}
              >
                <DraggableTaskChip
                  item={item}
                  appearance={compact ? 'pill' : 'fill'}
                  isSelected={item.sourceType === 'event' && item.sourceId === selectedItemId}
                  onClick={onSelectItem}
                  onDeleteItem={onDeleteItem}
                  onAddToProject={onAddToProject}
                />
              </div>
            ))}
          </CalendarAllDayCell>
        </div>
      )}
      <div
        ref={scrollRef}
        data-calendar-scroll
        className={cn(
          'min-w-0 overflow-y-auto',
          compact ? 'h-64 shrink-0 scrollbar-none' : 'min-h-0 flex-1'
        )}
      >
        <div
          className={cn(
            'relative flex',
            compact
              ? '[--grid-line-color:color-mix(in_srgb,var(--border)_55%,transparent)]'
              : '[--grid-line-color:var(--border)]'
          )}
          style={{
            height: hourHeight * 24 + gridPadding * 2,
            paddingBlock: gridPadding || undefined
          }}
        >
          <div className={cn('shrink-0', compact ? 'w-12' : 'w-[48px] @xl:w-[72px]')}>
            {HOURS.map((hour) => (
              <div
                key={hour}
                className={cn('flex items-start justify-end', compact ? 'pe-1.5' : 'pe-3')}
                style={{ height: hourHeight }}
              >
                <span
                  className={cn(
                    'font-medium -translate-y-1/2 whitespace-nowrap',
                    compact
                      ? 'text-[10.5px] leading-[14px] tabular-nums text-text-tertiary'
                      : 'text-xs text-muted-foreground'
                  )}
                >
                  {formatHour(hour, clockFormat)}
                </span>
              </div>
            ))}
          </div>

          <div
            ref={gridRef}
            data-testid="day-time-grid"
            className={cn('relative flex-1', compact && 'me-3.5')}
            style={{ backgroundImage: gridLineBackground(hourHeight) }}
            onMouseDown={(e) => handlers.onMouseDown(e, 0)}
            onDoubleClick={(e) => handlers.onDoubleClick(e, 0)}
          >
            <CalendarTimedColumnDroppable
              date={anchorDate}
              hourHeight={hourHeight}
              dropPreview={compact}
              clockFormat={clockFormat}
            >
              {assignLanes(timedItems).map(({ item, lane, laneCount }) => {
                const pos = getEventPosition(item, hourHeight)
                const widthPct = 100 / laneCount
                const leftPct = lane * widthPct
                const movable = isEventMovable(item)
                const resizable = isEventResizable(item)
                const isDraggingThis = drag?.projectionId === item.projectionId
                return (
                  <div
                    key={item.projectionId}
                    className={cn(
                      'absolute z-10 px-0.5',
                      !compact && '@xl:px-1',
                      movable && 'cursor-grab',
                      isDraggingThis && 'opacity-40'
                    )}
                    style={{
                      top: pos.top,
                      height: pos.height,
                      left: `${leftPct}%`,
                      width: `${widthPct}%`
                    }}
                    onMouseDown={movable ? (e) => startMove(e, item, 0) : undefined}
                  >
                    <CalendarItemChip
                      item={item}
                      clockFormat={clockFormat}
                      layout={chipLayout}
                      appearance={chipAppearance}
                      isSelected={item.sourceType === 'event' && item.sourceId === selectedItemId}
                      onClick={handleChipClick}
                      onDeleteItem={onDeleteItem}
                      onAddToProject={onAddToProject}
                    />
                    {resizable && (
                      <>
                        <div
                          className="absolute inset-x-0 top-0 h-1.5 cursor-ns-resize"
                          onMouseDown={(e) => startResize(e, item, 0, 'start')}
                        />
                        <div
                          className="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize"
                          onMouseDown={(e) => startResize(e, item, 0, 'end')}
                        />
                      </>
                    )}
                  </div>
                )
              })}

              {drag &&
                (() => {
                  const draggedItem = items.find((it) => it.projectionId === drag.projectionId)
                  if (!draggedItem) return null
                  return (
                    <div
                      className={cn(
                        'pointer-events-none absolute inset-x-0 z-30 px-0.5',
                        !compact && '@xl:px-1'
                      )}
                      style={{ top: drag.top, height: drag.height }}
                    >
                      <CalendarItemChip
                        item={{ ...draggedItem, startAt: drag.startAt, endAt: drag.endAt }}
                        clockFormat={clockFormat}
                        layout={chipLayout}
                        appearance={chipAppearance}
                        isSelected
                      />
                    </div>
                  )
                })()}

              {today && (
                <div
                  data-testid="day-now-indicator"
                  className={cn(
                    'pointer-events-none absolute end-0 z-20 flex items-center',
                    compact ? '-start-1 -translate-y-1/2' : 'start-0'
                  )}
                  style={{ top: currentTimeOffset }}
                >
                  {compact ? (
                    <>
                      <div className="size-[7px] shrink-0 rounded-full bg-tint" />
                      <div className="h-[1.5px] flex-1 bg-tint" />
                    </>
                  ) : (
                    <>
                      <div className="size-2 rounded-full bg-tint shadow-[0_0_6px] shadow-tint/60" />
                      <div className="h-0.5 flex-1 bg-tint" />
                    </>
                  )}
                </div>
              )}

              {isDragging && selection && (
                <MarqueeSelectionOverlay
                  top={selection.top}
                  height={selection.height}
                  startAt={selection.startAt}
                  endAt={selection.endAt}
                  clockFormat={clockFormat}
                />
              )}

              {selection && !isDragging && (
                <>
                  <MarqueeSelectionOverlay
                    top={selection.top}
                    height={selection.height}
                    startAt={selection.startAt}
                    endAt={selection.endAt}
                    clockFormat={clockFormat}
                  />
                  <CalendarQuickCreateDialog
                    anchorRect={selection.anchorRect}
                    startAt={selection.startAt}
                    endAt={selection.endAt}
                    isAllDay={false}
                    onSave={async (draft) => {
                      await onQuickSave?.(draft)
                      clearSelection()
                    }}
                    onDismiss={clearSelection}
                  />
                </>
              )}
            </CalendarTimedColumnDroppable>
          </div>
        </div>
      </div>
    </div>
  )
}

export default CalendarDayView
