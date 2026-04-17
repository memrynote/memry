import { useCallback, useMemo, useRef } from 'react'
import { CalendarItemChip } from './calendar-item-chip'
import { addLocalDays, getStartOfWeek, isToday, toLocalDateKey } from './date-utils'
import { MarqueeSelectionOverlay } from './marquee-selection-overlay'
import { CalendarQuickCreatePopover } from './calendar-quick-create-popover'
import { useTimeGridMarquee } from './use-time-grid-marquee'
import { useScrollToCurrentTime } from './use-scroll-to-current-time'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { formatHour } from '@/lib/time-format'
import { cn } from '@/lib/utils'
import type { CalendarProjectionItem } from '@/services/calendar-service'
import type { CalendarEventDraft } from './calendar-event-editor-drawer'

const HOUR_HEIGHT = 96
const HOURS = Array.from({ length: 24 }, (_, i) => i)
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DAY_NAMES_SHORT = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const GRID_LINE_BG =
  'repeating-linear-gradient(to bottom, transparent, transparent 47px, var(--grid-line-color) 47px, var(--grid-line-color) 48px)'

function getEventPosition(item: CalendarProjectionItem): { top: number; height: number } {
  const start = new Date(item.startAt)
  const top = start.getHours() * HOUR_HEIGHT + start.getMinutes() * (HOUR_HEIGHT / 60)
  const endMs = item.endAt ? new Date(item.endAt).getTime() : start.getTime() + 3600000
  const durationMinutes = (endMs - start.getTime()) / 60000
  return { top, height: Math.max(durationMinutes * (HOUR_HEIGHT / 60), 24) }
}

interface CalendarWeekViewProps {
  anchorDate: string
  items: CalendarProjectionItem[]
  onSelectItem?: (item: CalendarProjectionItem) => void
  onQuickSave?: (draft: CalendarEventDraft) => void
  onCreateEventWithRange?: (startAt: string, endAt: string, isAllDay: boolean) => void
}

export function CalendarWeekView({
  anchorDate,
  items,
  onSelectItem,
  onQuickSave,
  onCreateEventWithRange
}: CalendarWeekViewProps): React.JSX.Element {
  const {
    settings: { clockFormat }
  } = useGeneralSettings()
  const weekStart = getStartOfWeek(anchorDate)
  const days = Array.from({ length: 7 }, (_, i) => addLocalDays(weekStart, i))

  const gridRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const dateForColumn = useCallback((columnIndex: number) => days[columnIndex] ?? days[0], [days])
  const { selection, isDragging, handlers, clearSelection } = useTimeGridMarquee({
    gridRef,
    dateForColumn,
    columnCount: 7
  })
  const weekContainsToday = days.some((d) => isToday(d))
  useScrollToCurrentTime(scrollRef, weekContainsToday)

  const currentTimeOffset = useMemo(() => {
    const now = new Date()
    return now.getHours() * HOUR_HEIGHT + now.getMinutes() * (HOUR_HEIGHT / 60)
  }, [])

  return (
    <div className="flex h-full flex-col" data-testid="calendar-view" data-view="week">
      <div className="grid grid-cols-[48px_repeat(7,1fr)] border-b border-border @xl:grid-cols-[72px_repeat(7,1fr)]">
        <div />
        {days.map((day, i) => {
          const today = isToday(day)
          const dayNum = parseInt(day.slice(-2), 10)
          return (
            <div
              key={day}
              className="flex items-center justify-center gap-1 bg-background px-0.5 py-1 @xl:px-2 @xl:py-2"
            >
              <span className="text-xs font-medium text-muted-foreground">
                <span className="hidden @xl:inline">{DAY_NAMES[i]}</span>
                <span className="@xl:hidden">{DAY_NAMES_SHORT[i]}</span>
              </span>
              {today ? (
                <span className="inline-flex size-6 items-center justify-center rounded-full bg-tint text-xs font-semibold text-tint-foreground">
                  {dayNum}
                </span>
              ) : (
                <span className="text-xs font-semibold text-foreground">{dayNum}</span>
              )}
            </div>
          )
        })}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div
          ref={gridRef}
          className="relative grid grid-cols-[48px_repeat(7,1fr)] [--grid-line-color:var(--border)] @xl:grid-cols-[72px_repeat(7,1fr)]"
          style={{ height: HOUR_HEIGHT * 24 }}
        >
          <div>
            {HOURS.map((hour) => (
              <div
                key={hour}
                className="flex items-start justify-end pr-1 @xl:pr-3"
                style={{ height: HOUR_HEIGHT }}
              >
                <span className="text-xs font-medium text-muted-foreground -translate-y-1/2">
                  {formatHour(hour, clockFormat)}
                </span>
              </div>
            ))}
          </div>

          {days.map((day, i) => {
            const today = isToday(day)
            const dayItems = items.filter(
              (item) => !item.isAllDay && toLocalDateKey(item.startAt) === day
            )

            return (
              <div
                key={day}
                className={cn('relative border-r border-border', 'bg-background')}
                style={{ backgroundImage: GRID_LINE_BG }}
                onMouseDown={(e) => handlers.onMouseDown(e, i)}
                onDoubleClick={(e) => handlers.onDoubleClick(e, i)}
              >
                {dayItems.map((item) => {
                  const pos = getEventPosition(item)
                  return (
                    <div
                      key={item.projectionId}
                      className="absolute left-0.5 right-0.5 z-10"
                      style={{ top: pos.top, height: pos.height }}
                    >
                      <CalendarItemChip
                        item={item}
                        clockFormat={clockFormat}
                        onClick={onSelectItem}
                      />
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

                {isDragging && selection && selection.columnIndex === i && (
                  <MarqueeSelectionOverlay
                    top={selection.top}
                    height={selection.height}
                    startAt={selection.startAt}
                    endAt={selection.endAt}
                    clockFormat={clockFormat}
                  />
                )}

                {selection && !isDragging && selection.columnIndex === i && (
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
                      onSave={(draft) => {
                        onQuickSave?.(draft)
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
            )
          })}
        </div>
      </div>
    </div>
  )
}

export default CalendarWeekView
