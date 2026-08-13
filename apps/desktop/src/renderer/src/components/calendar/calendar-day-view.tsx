import { useCallback, useMemo, useRef } from 'react'
import { useT } from '@memry/i18n/renderer'
import { CalendarAllDayCell } from './calendar-allday-cell'
import { CalendarItemChip } from './calendar-item-chip'
import { CalendarTimedColumnDroppable } from './calendar-timed-column-droppable'
import { DraggableTaskChip } from './draggable-task-chip'
import { isToday, toLocalDateKey } from './date-utils'
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
import { useOptionalDragContext } from '@/contexts/drag-context'
import type { AnchorRect, CalendarEventDraft } from './types'
import { HOUR_HEIGHT } from './time-grid-constants'

const HOURS = Array.from({ length: 24 }, (_, i) => i)
const GRID_LINE_BG =
  'repeating-linear-gradient(to bottom, transparent, transparent 47px, var(--grid-line-color) 47px, var(--grid-line-color) 48px)'

function getEventPosition(item: CalendarProjectionItem): { top: number; height: number } {
  const start = new Date(item.startAt)
  const top = start.getHours() * HOUR_HEIGHT + start.getMinutes() * (HOUR_HEIGHT / 60)
  const endMs = item.endAt ? new Date(item.endAt).getTime() : start.getTime() + 3600000
  const durationMinutes = (endMs - start.getTime()) / 60000
  return { top, height: Math.max(durationMinutes * (HOUR_HEIGHT / 60), 24) }
}

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
}

export function CalendarDayView({
  anchorDate,
  items,
  selectedItemId,
  onSelectItem,
  onDeleteItem,
  onAddToProject,
  onMoveEvent,
  onQuickSave
}: CalendarDayViewProps): React.JSX.Element {
  const {
    settings: { clockFormat }
  } = useGeneralSettings()
  const { t } = useT('calendar')
  const isTaskDragInFlight = useOptionalDragContext()?.dragState.isDragging ?? false
  const gridRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const dateForColumn = useCallback(() => anchorDate, [anchorDate])
  const { selection, isDragging, handlers, clearSelection } = useTimeGridMarquee({
    gridRef,
    scrollRef,
    dateForColumn
  })
  const { drag, startMove, startResize, wasDragged } = useEventDrag({
    gridRef,
    dateForColumn,
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
  useScrollToCurrentTime(scrollRef, today)
  const dayItems = items.filter((item) => toLocalDateKey(item.startAt) === anchorDate)
  const timedItems = dayItems.filter((item) => !item.isAllDay)
  const allDayItems = dayItems.filter((item) => item.isAllDay)

  const currentTimeOffset = useMemo(() => {
    const now = new Date()
    return now.getHours() * HOUR_HEIGHT + now.getMinutes() * (HOUR_HEIGHT / 60)
  }, [])

  return (
    <div className="flex h-full flex-col" data-testid="calendar-view" data-view="day">
      {(allDayItems.length > 0 || isTaskDragInFlight) && (
        <div
          data-testid="day-all-day-strip"
          className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2"
        >
          <span className="w-[48px] shrink-0 text-xs font-medium text-muted-foreground @xl:w-[72px] pe-3 text-end">
            {t('time.all-day')}
          </span>
          <CalendarAllDayCell date={anchorDate} className="flex flex-1 flex-wrap gap-1.5">
            {allDayItems.map((item) => (
              <div key={item.projectionId} className="min-w-[140px]">
                <DraggableTaskChip
                  item={item}
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
      <div ref={scrollRef} data-calendar-scroll className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div
          className="relative flex [--grid-line-color:var(--border)]"
          style={{ height: HOUR_HEIGHT * 24 }}
        >
          <div className="w-[48px] shrink-0 @xl:w-[72px]">
            {HOURS.map((hour) => (
              <div
                key={hour}
                className="flex items-start justify-end pe-3"
                style={{ height: HOUR_HEIGHT }}
              >
                <span className="text-xs font-medium text-muted-foreground -translate-y-1/2">
                  {formatHour(hour, clockFormat)}
                </span>
              </div>
            ))}
          </div>

          <div
            ref={gridRef}
            data-testid="day-time-grid"
            className="relative flex-1"
            style={{ backgroundImage: GRID_LINE_BG }}
            onMouseDown={(e) => handlers.onMouseDown(e, 0)}
            onDoubleClick={(e) => handlers.onDoubleClick(e, 0)}
          >
            <CalendarTimedColumnDroppable date={anchorDate} hourHeight={HOUR_HEIGHT}>
              {assignLanes(timedItems).map(({ item, lane, laneCount }) => {
                const pos = getEventPosition(item)
                const widthPct = 100 / laneCount
                const leftPct = lane * widthPct
                const movable = isEventMovable(item)
                const resizable = isEventResizable(item)
                const isDraggingThis = drag?.projectionId === item.projectionId
                return (
                  <div
                    key={item.projectionId}
                    className={cn(
                      'absolute z-10 px-0.5 @xl:px-1',
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
                      className="pointer-events-none absolute inset-x-0 z-30 px-0.5 @xl:px-1"
                      style={{ top: drag.top, height: drag.height }}
                    >
                      <CalendarItemChip item={draggedItem} clockFormat={clockFormat} isSelected />
                    </div>
                  )
                })()}

              {today && (
                <div
                  className="pointer-events-none absolute start-0 end-0 z-20 flex items-center"
                  style={{ top: currentTimeOffset }}
                >
                  <div className="size-2 rounded-full bg-tint shadow-[0_0_6px] shadow-tint/60" />
                  <div className="h-0.5 flex-1 bg-tint" />
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
