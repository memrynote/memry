import { useCallback, useEffect, useMemo, useRef } from 'react'
import { CalendarItemChip } from './calendar-item-chip'
import { dateFromDayIndex, dayIndexFromDate, isToday, toLocalDateKey } from './date-utils'
import { MarqueeSelectionOverlay } from './marquee-selection-overlay'
import { CalendarQuickCreateDialog } from './calendar-quick-create-dialog'
import { useTimeGridMarquee } from './use-time-grid-marquee'
import { useScrollToCurrentTime } from './use-scroll-to-current-time'
import { useWeekInfiniteScroll } from './use-week-infinite-scroll'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { formatHour } from '@/lib/time-format'
import { cn } from '@/lib/utils'
import type { CalendarProjectionItem } from '@/services/calendar-service'
import type { CalendarEventDraft } from './calendar-event-editor-drawer'

const HOUR_HEIGHT = 96
const HEADER_HEIGHT = 40
const GUTTER_WIDTH = 48
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
  onQuickSave?: (draft: CalendarEventDraft) => void | Promise<void>
  onCreateEventWithRange?: (startAt: string, endAt: string, isAllDay: boolean) => void
  onVisibleDayStartChange?: (dayIndex: number, startDate: string) => void
}

export function CalendarWeekView({
  anchorDate,
  items,
  onSelectItem,
  onQuickSave,
  onCreateEventWithRange,
  onVisibleDayStartChange
}: CalendarWeekViewProps): React.JSX.Element {
  const {
    settings: { clockFormat }
  } = useGeneralSettings()

  const gridRef = useRef<HTMLDivElement>(null)
  const timeColumnRef = useRef<HTMLDivElement>(null)
  const headerScrollRef = useRef<HTMLDivElement>(null)
  const lastEmittedAnchorRef = useRef(anchorDate)

  const notifyVisibleStart = useCallback(
    (dayIndex: number) => {
      const startDate = dateFromDayIndex(dayIndex)
      lastEmittedAnchorRef.current = startDate
      onVisibleDayStartChange?.(dayIndex, startDate)
    },
    [onVisibleDayStartChange]
  )

  const { scrollContainerRef, virtualizer, visibleDayStart, scrollToDate, dateForDayIndex } =
    useWeekInfiniteScroll({
      initialDate: anchorDate,
      gutterWidth: GUTTER_WIDTH,
      onVisibleDayStartChange: notifyVisibleStart
    })

  useEffect(() => {
    if (anchorDate === lastEmittedAnchorRef.current) return
    const anchorIndex = dayIndexFromDate(anchorDate)
    if (anchorIndex >= visibleDayStart && anchorIndex < visibleDayStart + 7) return
    scrollToDate(anchorDate, { smooth: true })
  }, [anchorDate, visibleDayStart, scrollToDate])

  useEffect(() => {
    const body = scrollContainerRef.current
    if (!body) return
    const sync = (): void => {
      if (headerScrollRef.current) {
        headerScrollRef.current.scrollLeft = body.scrollLeft
      }
      if (timeColumnRef.current) {
        timeColumnRef.current.scrollTop = body.scrollTop
      }
    }
    body.addEventListener('scroll', sync, { passive: true })
    sync()
    return () => body.removeEventListener('scroll', sync)
  }, [scrollContainerRef])

  const virtualItems = virtualizer.getVirtualItems()
  const totalSize = virtualizer.getTotalSize()

  const getColumnElement = useCallback((dayIndex: number): HTMLElement | null => {
    const grid = gridRef.current
    if (!grid) return null
    return grid.querySelector<HTMLElement>(`[data-day-index="${dayIndex}"]`)
  }, [])

  const dateForColumn = useCallback(
    (columnIndex: number) => dateForDayIndex(columnIndex),
    [dateForDayIndex]
  )

  const { selection, isDragging, handlers, clearSelection } = useTimeGridMarquee({
    gridRef,
    dateForColumn,
    columnCount: virtualizer.options.count,
    getColumnElement
  })

  const weekContainsToday = useMemo(() => {
    for (let i = 0; i < 7; i++) {
      if (isToday(dateFromDayIndex(visibleDayStart + i))) return true
    }
    return false
  }, [visibleDayStart])

  useScrollToCurrentTime(scrollContainerRef, weekContainsToday)

  const itemsByDate = useMemo(() => {
    const map = new Map<string, CalendarProjectionItem[]>()
    for (const item of items) {
      if (item.isAllDay) continue
      const dateKey = toLocalDateKey(item.startAt)
      const bucket = map.get(dateKey)
      if (bucket) {
        bucket.push(item)
      } else {
        map.set(dateKey, [item])
      }
    }
    return map
  }, [items])

  const currentTimeOffset = useMemo(() => {
    const now = new Date()
    return now.getHours() * HOUR_HEIGHT + now.getMinutes() * (HOUR_HEIGHT / 60)
  }, [])

  return (
    <div
      className="flex h-full min-h-0 flex-col [--grid-line-color:var(--border)]"
      data-testid="calendar-view"
      data-view="week"
      data-anchor-date={anchorDate}
      data-visible-day-start={visibleDayStart}
    >
      <div className="flex border-b border-border">
        <div
          className="shrink-0 bg-background"
          style={{ width: GUTTER_WIDTH, height: HEADER_HEIGHT }}
        />
        <div
          ref={headerScrollRef}
          className="min-w-0 flex-1 overflow-hidden"
          style={{ height: HEADER_HEIGHT }}
        >
          <div className="relative" style={{ width: totalSize, height: HEADER_HEIGHT }}>
            {virtualItems.map((vi) => {
              const date = dateForDayIndex(vi.index)
              const isCurrent = isToday(date)
              const dayNum = parseInt(date.slice(-2), 10)
              const dayOfWeek = new Date(date).getDay()
              return (
                <div
                  key={vi.key}
                  className="absolute top-0 flex items-center justify-center gap-1 bg-background"
                  style={{
                    left: vi.start,
                    width: vi.size,
                    height: HEADER_HEIGHT
                  }}
                >
                  <span className="text-xs font-medium text-muted-foreground">
                    <span className="hidden @xl:inline">{DAY_NAMES[dayOfWeek]}</span>
                    <span className="@xl:hidden">{DAY_NAMES_SHORT[dayOfWeek]}</span>
                  </span>
                  {isCurrent ? (
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
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div
          ref={timeColumnRef}
          className="shrink-0 overflow-hidden bg-background"
          style={{ width: GUTTER_WIDTH }}
        >
          <div style={{ height: HOUR_HEIGHT * 24 }}>
            {HOURS.map((hour) => (
              <div
                key={hour}
                className="flex items-start justify-end pr-1"
                style={{ height: HOUR_HEIGHT }}
              >
                <span className="-translate-y-1/2 text-xs font-medium text-muted-foreground">
                  {formatHour(hour, clockFormat)}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div
          ref={scrollContainerRef}
          className="scrollbar-none relative min-w-0 flex-1 overflow-auto"
          data-testid="calendar-week-scroll"
        >
          <div
            ref={gridRef}
            className="relative"
            style={{ width: totalSize, height: HOUR_HEIGHT * 24 }}
          >
            {virtualItems.map((vi) => {
              const date = dateForDayIndex(vi.index)
              const dayItems = itemsByDate.get(date) ?? []
              const today = isToday(date)

              return (
                <div
                  key={vi.key}
                  data-day-index={vi.index}
                  data-date={date}
                  className={cn('absolute top-0 border-r border-border bg-background')}
                  style={{
                    left: vi.start,
                    width: vi.size,
                    height: HOUR_HEIGHT * 24,
                    backgroundImage: GRID_LINE_BG
                  }}
                  onMouseDown={(e) => handlers.onMouseDown(e, vi.index)}
                  onDoubleClick={(e) => handlers.onDoubleClick(e, vi.index)}
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

                  {isDragging && selection && selection.columnIndex === vi.index && (
                    <MarqueeSelectionOverlay
                      top={selection.top}
                      height={selection.height}
                      startAt={selection.startAt}
                      endAt={selection.endAt}
                      clockFormat={clockFormat}
                    />
                  )}

                  {selection && !isDragging && selection.columnIndex === vi.index && (
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
    </div>
  )
}

export default CalendarWeekView
