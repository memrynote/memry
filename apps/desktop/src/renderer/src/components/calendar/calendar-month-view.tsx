import { useMemo, useRef } from 'react'
import { useT } from '@memry/i18n/renderer'
import { CalendarMonthDayCell } from './calendar-month-day-cell'
import { CalendarQuickCreateDialog } from './calendar-quick-create-dialog'
import { CalendarItemChip } from './calendar-item-chip'
import {
  getMonthGridDays,
  getWeekdayLabels,
  isMultiDaySpan,
  isToday,
  isSameMonth,
  isWeekend,
  spanEndDateKey,
  spanStartDateKey,
  toLocalDateKey
} from './date-utils'
import { useMonthGridMarquee } from './use-month-grid-marquee'
import { useContainerWidth } from '@/hooks/use-container-width'
import { useWeekStartsOn } from '@/hooks/use-calendar-preferences'
import type { AnchorRect, CalendarEventDraft } from './types'
import type { CalendarProjectionItem } from '@/services/calendar-service'

// Bars sit under the day number and above the per-day chips.
const SPAN_BAR_TOP = 30
const SPAN_BAR_HEIGHT = 20
const SPAN_BAR_GAP = 2

interface WeekSpanBar {
  item: CalendarProjectionItem
  columnStart: number
  columnEnd: number
  lane: number
  continuesBefore: boolean
  continuesAfter: boolean
}

/**
 * Clips every multi-day item to one week row and stacks the clipped segments
 * into lanes, so a span renders as a single continuous bar across the row.
 */
function buildWeekSpanBars(items: CalendarProjectionItem[], weekDays: string[]) {
  const rowStart = weekDays[0]
  const rowEnd = weekDays[weekDays.length - 1]
  const segments = items.flatMap((item) => {
    if (!isMultiDaySpan(item)) return []
    const start = spanStartDateKey(item)
    const end = spanEndDateKey(item)
    if (end < rowStart || start > rowEnd) return []
    const clippedStart = start < rowStart ? rowStart : start
    const clippedEnd = end > rowEnd ? rowEnd : end
    return [
      {
        item,
        columnStart: weekDays.indexOf(clippedStart),
        columnEnd: weekDays.indexOf(clippedEnd),
        continuesBefore: start < rowStart,
        continuesAfter: end > rowEnd
      }
    ]
  })
  segments.sort((a, b) => a.columnStart - b.columnStart || b.columnEnd - a.columnEnd)

  const laneEndColumn: number[] = []
  const bars = segments.map((segment) => {
    let lane = laneEndColumn.findIndex((end) => end < segment.columnStart)
    if (lane === -1) lane = laneEndColumn.length
    laneEndColumn[lane] = segment.columnEnd
    return { ...segment, lane }
  })

  return { bars: bars satisfies WeekSpanBar[], laneCount: laneEndColumn.length }
}

function maxVisibleEventsForColumnWidth(columnWidth: number): number {
  if (columnWidth < 80) return 1
  if (columnWidth < 120) return 2
  return 3
}

interface CalendarMonthViewProps {
  anchorDate: string
  items: CalendarProjectionItem[]
  selectedItemId: string | null
  onSelectItem?: (item: CalendarProjectionItem, rect: AnchorRect) => void
  onDeleteItem?: (item: CalendarProjectionItem) => void
  onAddToProject?: (eventId: string) => void
  onQuickSave?: (draft: CalendarEventDraft) => void | Promise<void>
}

export function CalendarMonthView({
  anchorDate,
  items,
  selectedItemId,
  onSelectItem,
  onDeleteItem,
  onAddToProject,
  onQuickSave
}: CalendarMonthViewProps): React.JSX.Element {
  const { t, i18n } = useT('calendar')
  const weekStartsOn = useWeekStartsOn()
  const gridDays = getMonthGridDays(anchorDate, weekStartsOn)
  const [containerWidth, containerRef] = useContainerWidth()
  const columnWidth = containerWidth / 7
  const maxVisibleEvents = maxVisibleEventsForColumnWidth(columnWidth)
  const dayNames = useMemo(
    () => getWeekdayLabels(i18n.language, weekStartsOn),
    [i18n.language, weekStartsOn]
  )

  const gridRef = useRef<HTMLDivElement | null>(null)
  const { selection, isDragging, handlers, clearSelection } = useMonthGridMarquee({ gridRef })

  const weeks = useMemo(() => {
    const rows: string[][] = []
    for (let i = 0; i < gridDays.length; i += 7) rows.push(gridDays.slice(i, i + 7))
    return rows.map((weekDays) => ({ weekDays, ...buildWeekSpanBars(items, weekDays) }))
    // `gridDays` is recomputed each render from the anchor, so key on the anchor.
  }, [anchorDate, weekStartsOn, items]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex h-full flex-col" data-testid="calendar-view" data-view="month">
      <div className="grid grid-cols-7 border-b border-border">
        {dayNames.map((name) => (
          <div
            key={name}
            className="bg-background px-2 py-2 text-center text-xs font-medium text-muted-foreground"
          >
            {name}
          </div>
        ))}
      </div>

      <div
        role="application"
        aria-label={t('calendar:view.monthGridLabel')}
        ref={(el) => {
          containerRef(el)
          gridRef.current = el
        }}
        className="flex flex-1 flex-col"
        onMouseDown={handlers.onMouseDown}
        onDoubleClick={handlers.onDoubleClick}
      >
        {weeks.map(({ weekDays, bars, laneCount }) => (
          <div key={weekDays[0]} className="relative grid flex-1 grid-cols-7">
            {weekDays.map((day) => {
              const inMonth = isSameMonth(day, anchorDate)
              const today = isToday(day)
              const weekend = isWeekend(day)
              const dayNum = parseInt(day.slice(-2), 10)
              const dayItems = items.filter(
                (item) => !isMultiDaySpan(item) && toLocalDateKey(item.startAt) === day
              )
              const isSelected =
                selection && !isDragging && day >= selection.startDate && day <= selection.endDate
              const isDragSelected =
                isDragging && selection && day >= selection.startDate && day <= selection.endDate

              return (
                <CalendarMonthDayCell
                  key={day}
                  day={day}
                  dayNum={dayNum}
                  inMonth={inMonth}
                  today={today}
                  weekend={weekend}
                  highlighted={Boolean(isSelected || isDragSelected)}
                  items={dayItems}
                  maxVisibleEvents={Math.max(maxVisibleEvents - laneCount, 1)}
                  spanReservedHeight={laneCount * (SPAN_BAR_HEIGHT + SPAN_BAR_GAP)}
                  selectedItemId={selectedItemId}
                  onSelectItem={onSelectItem}
                  onDeleteItem={onDeleteItem}
                  onAddToProject={onAddToProject}
                />
              )
            })}

            {bars.map((bar) => (
              <div
                key={bar.item.projectionId}
                data-testid="calendar-span-bar"
                data-span-columns={bar.columnEnd - bar.columnStart + 1}
                className="pointer-events-auto absolute px-1"
                style={{
                  insetInlineStart: `${(bar.columnStart / 7) * 100}%`,
                  width: `${((bar.columnEnd - bar.columnStart + 1) / 7) * 100}%`,
                  top: SPAN_BAR_TOP + bar.lane * (SPAN_BAR_HEIGHT + SPAN_BAR_GAP),
                  height: SPAN_BAR_HEIGHT,
                  paddingInlineStart: bar.continuesBefore ? 0 : undefined,
                  paddingInlineEnd: bar.continuesAfter ? 0 : undefined
                }}
              >
                <CalendarItemChip
                  item={bar.item}
                  isSelected={bar.item.sourceId === selectedItemId}
                  onClick={onSelectItem}
                  onDeleteItem={onDeleteItem}
                  onAddToProject={onAddToProject}
                />
              </div>
            ))}
          </div>
        ))}
      </div>

      {selection && !isDragging && (
        <CalendarQuickCreateDialog
          anchorRect={selection.anchorRect}
          startAt={selection.startDate}
          endAt={selection.endDate}
          isAllDay={true}
          onSave={async (draft) => {
            await onQuickSave?.(draft)
            clearSelection()
          }}
          onDismiss={clearSelection}
        />
      )}
    </div>
  )
}

export default CalendarMonthView
