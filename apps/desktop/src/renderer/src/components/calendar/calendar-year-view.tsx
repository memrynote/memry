import { CalendarItemChip } from './calendar-item-chip'
import { parseLocalDate, toLocalDateKey } from './date-utils'
import type { CalendarProjectionItem } from '@/services/calendar-service'

function monthKey(value: string): string {
  return toLocalDateKey(value).slice(0, 7)
}

interface CalendarYearViewProps {
  anchorDate: string
  items: CalendarProjectionItem[]
  onSelectItem?: (item: CalendarProjectionItem) => void
}

export function CalendarYearView({
  anchorDate,
  items,
  onSelectItem
}: CalendarYearViewProps): React.JSX.Element {
  const year = parseLocalDate(anchorDate).getFullYear()
  const months = Array.from({ length: 12 }, (_, index) => {
    const monthDate = new Date(year, index, 1)
    const key = toLocalDateKey(monthDate.toISOString()).slice(0, 7)
    return {
      key,
      label: new Intl.DateTimeFormat(undefined, { month: 'long' }).format(monthDate),
      items: items.filter((item) => monthKey(item.startAt) === key)
    }
  })

  return (
    <section className="space-y-4" data-testid="calendar-view" data-view="year">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Year view</h2>
        <p className="text-sm text-muted-foreground">A twelve-month heatmap of calendar load and item mix.</p>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {months.map((month) => (
          <div key={month.key} className="rounded-2xl border border-border/70 bg-card/50 p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-foreground">{month.label}</h3>
              <span className="text-xs text-muted-foreground">{month.items.length} items</span>
            </div>
            <div className="space-y-2">
              {month.items.length === 0 ? (
                <p className="text-xs text-muted-foreground">No projected items.</p>
              ) : (
                month.items.slice(0, 3).map((item) => (
                  <CalendarItemChip key={item.projectionId} item={item} onClick={onSelectItem} />
                ))
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

export default CalendarYearView
