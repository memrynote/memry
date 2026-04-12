import { CalendarItemChip } from './calendar-item-chip'
import { addLocalDays, toLocalDateKey } from './date-utils'
import type { CalendarProjectionItem } from '@/services/calendar-service'

interface CalendarWeekViewProps {
  anchorDate: string
  items: CalendarProjectionItem[]
  onSelectItem?: (item: CalendarProjectionItem) => void
}

export function CalendarWeekView({
  anchorDate,
  items,
  onSelectItem
}: CalendarWeekViewProps): React.JSX.Element {
  const days = Array.from({ length: 7 }, (_, index) => addLocalDays(anchorDate, index))

  return (
    <section className="space-y-4" data-testid="calendar-view" data-view="week">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Week view</h2>
        <p className="text-sm text-muted-foreground">A seven-day lane for all projected calendar items.</p>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-7">
        {days.map((day) => {
          const dayItems = items.filter((item) => toLocalDateKey(item.startAt) === day)
          return (
            <div key={day} className="rounded-2xl border border-border/70 bg-card/60 p-3">
              <div className="mb-3 text-sm font-semibold text-foreground">{day}</div>
              <div className="space-y-2">
                {dayItems.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Nothing scheduled.</p>
                ) : (
                  dayItems.map((item) => (
                    <CalendarItemChip key={item.projectionId} item={item} onClick={onSelectItem} />
                  ))
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

export default CalendarWeekView
