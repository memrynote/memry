import { useRef } from 'react'
import { CalendarItemChip } from './calendar-item-chip'
import { CalendarQuickCreatePopover } from './calendar-quick-create-popover'
import { getMonthGridDays, isToday, isSameMonth, toLocalDateKey } from './date-utils'
import { useMonthGridMarquee } from './use-month-grid-marquee'
import { cn } from '@/lib/utils'
import { useContainerWidth } from '@/hooks/use-container-width'
import type { CalendarEventDraft } from './calendar-event-editor-drawer'
import type { CalendarProjectionItem } from '@/services/calendar-service'

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

interface CalendarMonthViewProps {
  anchorDate: string
  items: CalendarProjectionItem[]
  onSelectItem?: (item: CalendarProjectionItem) => void
  onQuickSave?: (draft: CalendarEventDraft) => void | Promise<void>
  onCreateEventWithRange?: (startAt: string, endAt: string, isAllDay: boolean) => void
}

export function CalendarMonthView({
  anchorDate,
  items,
  onSelectItem,
  onQuickSave,
  onCreateEventWithRange
}: CalendarMonthViewProps): React.JSX.Element {
  const gridDays = getMonthGridDays(anchorDate)
  const [containerWidth, containerRef] = useContainerWidth()
  const columnWidth = containerWidth / 7
  const maxVisibleEvents = columnWidth < 80 ? 1 : columnWidth < 120 ? 2 : 3

  const gridRef = useRef<HTMLDivElement>(null)
  const { selection, isDragging, handlers, clearSelection } = useMonthGridMarquee({ gridRef })

  return (
    <div className="flex h-full flex-col" data-testid="calendar-view" data-view="month">
      <div className="grid grid-cols-7 border-b border-border">
        {DAY_NAMES.map((name) => (
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
          const dayNum = parseInt(day.slice(-2), 10)
          const dayItems = items.filter((item) => toLocalDateKey(item.startAt) === day)
          const isSelected =
            selection && !isDragging && day >= selection.startDate && day <= selection.endDate
          const isDragSelected =
            isDragging && selection && day >= selection.startDate && day <= selection.endDate

          return (
            <div
              key={day}
              data-date={day}
              className={cn(
                'flex flex-col gap-1 border-b border-r border-border p-1 @xl:p-2',
                inMonth ? 'bg-background' : 'bg-muted/50',
                (isSelected || isDragSelected) && 'ring-2 ring-inset ring-tint/40 bg-tint/10'
              )}
            >
              <div className="mb-0.5">
                {today ? (
                  <span className="inline-flex size-6 items-center justify-center rounded-full bg-tint text-xs font-semibold text-tint-foreground">
                    {dayNum}
                  </span>
                ) : (
                  <span
                    className={cn(
                      'inline-block text-xs font-medium leading-6',
                      inMonth ? 'text-foreground' : 'text-muted-foreground'
                    )}
                  >
                    {dayNum}
                  </span>
                )}
              </div>

              <div className="flex flex-col gap-1">
                {dayItems.slice(0, maxVisibleEvents).map((item) => (
                  <CalendarItemChip key={item.projectionId} item={item} onClick={onSelectItem} />
                ))}
                {dayItems.length > maxVisibleEvents && (
                  <span className="text-xs font-semibold text-muted-foreground">
                    {dayItems.length - maxVisibleEvents} more...
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {selection && !isDragging && (
        <CalendarQuickCreatePopover
          anchorRect={selection.anchorRect}
          startAt={selection.startDate}
          endAt={selection.endDate}
          isAllDay={true}
          onSave={async (draft) => {
            await onQuickSave?.(draft)
            clearSelection()
          }}
          onDismiss={clearSelection}
          onOpenFullEditor={(draft) => {
            onCreateEventWithRange?.(draft.startAt, draft.endAt, true)
            clearSelection()
          }}
        />
      )}
    </div>
  )
}

export default CalendarMonthView
