import { useCallback, useMemo, useRef } from 'react'
import { CalendarItemChip } from './calendar-item-chip'
import { isToday, toLocalDateKey } from './date-utils'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { formatHour } from '@/lib/time-format'
import type { CalendarProjectionItem } from '@/services/calendar-service'
import { useTimeGridMarquee } from './use-time-grid-marquee'
import { MarqueeSelectionOverlay } from './marquee-selection-overlay'
import { CalendarQuickCreatePopover } from './calendar-quick-create-popover'
import { useScrollToCurrentTime } from './use-scroll-to-current-time'
import type { CalendarEventDraft } from './calendar-event-editor-drawer'

const HOUR_HEIGHT = 96
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
  onSelectItem?: (item: CalendarProjectionItem) => void
  onQuickSave?: (draft: CalendarEventDraft) => void | Promise<void>
  onCreateEventWithRange?: (startAt: string, endAt: string, isAllDay: boolean) => void
}

export function CalendarDayView({
  anchorDate,
  items,
  onSelectItem,
  onQuickSave,
  onCreateEventWithRange
}: CalendarDayViewProps): React.JSX.Element {
  const {
    settings: { clockFormat }
  } = useGeneralSettings()
  const gridRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const dateForColumn = useCallback(() => anchorDate, [anchorDate])
  const { selection, isDragging, handlers, clearSelection } = useTimeGridMarquee({
    gridRef,
    dateForColumn
  })
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
      {allDayItems.length > 0 && (
        <div
          data-testid="day-all-day-strip"
          className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2"
        >
          <span className="w-[48px] shrink-0 text-xs font-medium text-muted-foreground @xl:w-[72px] pr-3 text-right">
            All day
          </span>
          <div className="flex flex-1 flex-wrap gap-1.5">
            {allDayItems.map((item) => (
              <div key={item.projectionId} className="min-w-[140px]">
                <CalendarItemChip item={item} clockFormat={clockFormat} onClick={onSelectItem} />
              </div>
            ))}
          </div>
        </div>
      )}
      <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div
          className="relative flex [--grid-line-color:var(--border)]"
          style={{ height: HOUR_HEIGHT * 24 }}
        >
          <div className="w-[48px] shrink-0 @xl:w-[72px]">
            {HOURS.map((hour) => (
              <div
                key={hour}
                className="flex items-start justify-end pr-3"
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
            {timedItems.map((item) => {
              const pos = getEventPosition(item)
              return (
                <div
                  key={item.projectionId}
                  className="absolute left-0.5 right-0.5 z-10 @xl:left-1 @xl:right-1"
                  style={{ top: pos.top, height: pos.height }}
                >
                  <CalendarItemChip item={item} clockFormat={clockFormat} onClick={onSelectItem} />
                </div>
              )
            })}

            {today && (
              <div
                className="absolute left-0 right-0 z-20 flex items-center"
                style={{ top: currentTimeOffset }}
              >
                <div className="size-2 rounded-full bg-tint" />
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
                <CalendarQuickCreatePopover
                  anchorRect={selection.anchorRect}
                  startAt={selection.startAt}
                  endAt={selection.endAt}
                  isAllDay={false}
                  onSave={async (draft) => {
                    await onQuickSave?.(draft)
                    clearSelection()
                  }}
                  onDismiss={clearSelection}
                  onOpenFullEditor={(draft) => {
                    onCreateEventWithRange?.(draft.startAt, draft.endAt, false)
                    clearSelection()
                  }}
                />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default CalendarDayView
