import { CalendarItemChip } from './calendar-item-chip'
import type { CalendarProjectionItem } from '@/services/calendar-service'

function toDateKey(value: string): string {
  return new Date(value).toISOString().slice(0, 10)
}

interface CalendarDayViewProps {
  anchorDate: string
  items: CalendarProjectionItem[]
  onSelectItem?: (item: CalendarProjectionItem) => void
}

export function CalendarDayView({
  anchorDate,
  items,
  onSelectItem
}: CalendarDayViewProps): React.JSX.Element {
  const dayItems = items.filter((item) => toDateKey(item.startAt) === anchorDate)
  const allDayItems = dayItems.filter((item) => item.isAllDay)
  const timedItems = dayItems.filter((item) => !item.isAllDay)

  return (
    <section className="space-y-6" data-testid="calendar-view" data-view="day">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Day view</h2>
        <p className="text-sm text-muted-foreground">One focused day for tasks, reminders, and events.</p>
      </div>

      {allDayItems.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            All day
          </h3>
          <div className="space-y-2">
            {allDayItems.map((item) => (
              <CalendarItemChip key={item.projectionId} item={item} onClick={onSelectItem} />
            ))}
          </div>
        </div>
      )}

      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          Timeline
        </h3>
        {timedItems.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
            No timed items in this range.
          </p>
        ) : (
          <div className="space-y-2">
            {timedItems.map((item) => (
              <CalendarItemChip key={item.projectionId} item={item} onClick={onSelectItem} />
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

export default CalendarDayView
