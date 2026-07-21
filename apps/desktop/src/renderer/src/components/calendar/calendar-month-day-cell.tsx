import { useT } from '@memry/i18n/renderer'
import { DraggableTaskChip } from './draggable-task-chip'
import { useCalendarDateDroppable } from './use-calendar-date-droppable'
import { cn } from '@/lib/utils'
import type { AnchorRect } from './types'
import type { CalendarProjectionItem } from '@/services/calendar-service'

interface CalendarMonthDayCellProps {
  day: string
  dayNum: number
  inMonth: boolean
  today: boolean
  weekend: boolean
  highlighted: boolean
  items: CalendarProjectionItem[]
  maxVisibleEvents: number
  selectedItemId: string | null
  onSelectItem?: (item: CalendarProjectionItem, rect: AnchorRect) => void
  onDeleteItem?: (item: CalendarProjectionItem) => void
  onAddToProject?: (eventId: string) => void
}

export function CalendarMonthDayCell({
  day,
  dayNum,
  inMonth,
  today,
  weekend,
  highlighted,
  items,
  maxVisibleEvents,
  selectedItemId,
  onSelectItem,
  onDeleteItem,
  onAddToProject
}: CalendarMonthDayCellProps): React.JSX.Element {
  const { t } = useT('calendar')
  // Month cells are date-only: a dropped task keeps whatever time it had.
  const { setNodeRef, isOver } = useCalendarDateDroppable({ date: day, timeBehavior: 'preserve' })

  return (
    <div
      ref={setNodeRef}
      data-date={day}
      className={cn(
        'flex flex-col gap-1 border-b border-e border-border p-1 @xl:p-2',
        inMonth ? (weekend ? 'bg-muted/30' : 'bg-background') : 'bg-muted/50',
        highlighted && 'ring-2 ring-inset ring-tint/40 bg-tint/10',
        isOver && 'ring-2 ring-inset ring-tint bg-tint/15'
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
        {items.slice(0, maxVisibleEvents).map((item) => (
          <DraggableTaskChip
            key={item.projectionId}
            item={item}
            isSelected={item.sourceType === 'event' && item.sourceId === selectedItemId}
            onClick={onSelectItem}
            onDeleteItem={onDeleteItem}
            onAddToProject={onAddToProject}
          />
        ))}
        {items.length > maxVisibleEvents && (
          <span className="text-xs font-semibold text-muted-foreground">
            {t('time.more-events', { count: items.length - maxVisibleEvents })}
          </span>
        )}
      </div>
    </div>
  )
}
