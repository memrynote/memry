import { CalendarItemChip } from './calendar-item-chip'
import type { CalendarProjectionItem } from '@/services/calendar-service'

function toDateKey(value: string): string {
  return new Date(value).toISOString().slice(0, 10)
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

interface CalendarMonthViewProps {
  anchorDate: string
  items: CalendarProjectionItem[]
  onSelectItem?: (item: CalendarProjectionItem) => void
}

export function CalendarMonthView({
  anchorDate,
  items,
  onSelectItem
}: CalendarMonthViewProps): React.JSX.Element {
  const anchor = new Date(`${anchorDate}T00:00:00.000Z`)
  const year = anchor.getUTCFullYear()
  const month = anchor.getUTCMonth()
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  const days = Array.from({ length: daysInMonth }, (_, index) => {
    const day = index + 1
    return `${year}-${pad(month + 1)}-${pad(day)}`
  })

  return (
    <section className="space-y-4" data-testid="calendar-view" data-view="month">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Month view</h2>
        <p className="text-sm text-muted-foreground">A full-month snapshot with visible projected work.</p>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-7">
        {days.map((day) => {
          const dayItems = items.filter((item) => toDateKey(item.startAt) === day)
          return (
            <div key={day} className="min-h-36 rounded-2xl border border-border/70 bg-card/50 p-3">
              <div className="mb-3 text-sm font-semibold text-foreground">{day.slice(-2)}</div>
              <div className="space-y-2">
                {dayItems.slice(0, 4).map((item) => (
                  <CalendarItemChip key={item.projectionId} item={item} onClick={onSelectItem} />
                ))}
                {dayItems.length > 4 && (
                  <p className="text-xs text-muted-foreground">+{dayItems.length - 4} more</p>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

export default CalendarMonthView
