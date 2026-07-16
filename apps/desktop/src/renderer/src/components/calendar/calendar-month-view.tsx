import { useMemo, useRef } from 'react'
import { useT } from '@memry/i18n/renderer'
import { CalendarMonthDayCell } from './calendar-month-day-cell'
import { CalendarQuickCreateDialog } from './calendar-quick-create-dialog'
import {
  getMonthGridDays,
  getWeekdayLabels,
  isToday,
  isSameMonth,
  isWeekend,
  toLocalDateKey
} from './date-utils'
import { useMonthGridMarquee } from './use-month-grid-marquee'
import { useContainerWidth } from '@/hooks/use-container-width'
import { useWeekStartsOn } from '@/hooks/use-calendar-preferences'
import type { AnchorRect, CalendarEventDraft } from './types'
import type { CalendarProjectionItem } from '@/services/calendar-service'

interface CalendarMonthViewProps {
  anchorDate: string
  items: CalendarProjectionItem[]
  selectedItemId: string | null
  onSelectItem?: (item: CalendarProjectionItem, rect: AnchorRect) => void
  onDeleteItem?: (item: CalendarProjectionItem) => void
  onQuickSave?: (draft: CalendarEventDraft) => void | Promise<void>
}

export function CalendarMonthView({
  anchorDate,
  items,
  selectedItemId,
  onSelectItem,
  onDeleteItem,
  onQuickSave
}: CalendarMonthViewProps): React.JSX.Element {
  const { i18n } = useT('calendar')
  const weekStartsOn = useWeekStartsOn()
  const gridDays = getMonthGridDays(anchorDate, weekStartsOn)
  const [containerWidth, containerRef] = useContainerWidth()
  const columnWidth = containerWidth / 7
  const maxVisibleEvents = columnWidth < 80 ? 1 : columnWidth < 120 ? 2 : 3
  const dayNames = useMemo(
    () => getWeekdayLabels(i18n.language, weekStartsOn),
    [i18n.language, weekStartsOn]
  )

  const gridRef = useRef<HTMLDivElement>(null)
  const { selection, isDragging, handlers, clearSelection } = useMonthGridMarquee({ gridRef })

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
        ref={(el) => {
          containerRef(el)
          ;(gridRef as React.MutableRefObject<HTMLDivElement | null>).current = el
        }}
        className="grid flex-1 grid-cols-7"
        onMouseDown={handlers.onMouseDown}
        onDoubleClick={handlers.onDoubleClick}
      >
        {gridDays.map((day) => {
          const inMonth = isSameMonth(day, anchorDate)
          const today = isToday(day)
          const weekend = isWeekend(day)
          const dayNum = parseInt(day.slice(-2), 10)
          const dayItems = items.filter((item) => toLocalDateKey(item.startAt) === day)
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
              maxVisibleEvents={maxVisibleEvents}
              selectedItemId={selectedItemId}
              onSelectItem={onSelectItem}
              onDeleteItem={onDeleteItem}
            />
          )
        })}
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
