import { cn } from '@/lib/utils'
import { ChevronLeft, ChevronRight } from '@/lib/icons'
import {
  addLocalMonths,
  getMonthGridDays,
  isToday,
  isSameMonth,
  parseLocalDate,
  toLocalDateKey
} from './date-utils'
import type { CalendarProjectionItem } from '@/services/calendar-service'

const DAY_HEADERS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

interface CalendarMiniMonthProps {
  anchorDate: string
  items: CalendarProjectionItem[]
  onDateSelect: (date: string) => void
  onMonthChange: (newAnchor: string) => void
}

export function CalendarMiniMonth({
  anchorDate,
  items,
  onDateSelect,
  onMonthChange
}: CalendarMiniMonthProps): React.JSX.Element {
  const date = parseLocalDate(anchorDate)
  const monthLabel = new Intl.DateTimeFormat(undefined, {
    month: 'long',
    year: 'numeric'
  }).format(date)

  const gridDays = getMonthGridDays(anchorDate)
  const daysWithEvents = new Set(items.map((item) => toLocalDateKey(item.startAt)))

  return (
    <div className="px-6 py-5">
      <div className="mb-3 flex items-center justify-between">
        <button
          type="button"
          className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-surface-active"
          onClick={() => onMonthChange(addLocalMonths(anchorDate, -1))}
          aria-label="Previous month"
        >
          <ChevronLeft className="size-5" />
        </button>
        <span className="text-sm font-semibold text-foreground">{monthLabel}</span>
        <button
          type="button"
          className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-surface-active"
          onClick={() => onMonthChange(addLocalMonths(anchorDate, 1))}
          aria-label="Next month"
        >
          <ChevronRight className="size-5" />
        </button>
      </div>

      <div className="mb-0.5 grid grid-cols-7">
        {DAY_HEADERS.map((header) => (
          <div key={header} className="py-1 text-center text-sm font-medium text-muted-foreground">
            {header}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7">
        {gridDays.map((day) => {
          const inMonth = isSameMonth(day, anchorDate)
          const today = isToday(day)
          const hasEvent = daysWithEvents.has(day)
          const dayNum = parseInt(day.slice(-2), 10)

          return (
            <button
              key={day}
              type="button"
              className="relative flex flex-col items-center py-0.5"
              onClick={() => onDateSelect(day)}
            >
              <span
                className={cn(
                  'flex size-10 items-center justify-center rounded-full text-sm',
                  today && 'bg-tint font-medium text-tint-foreground',
                  !today && inMonth && 'text-foreground hover:bg-surface-active',
                  !today && !inMonth && 'text-muted-foreground'
                )}
              >
                {dayNum}
              </span>
              {hasEvent && <span className="absolute bottom-0.5 size-[5px] rounded-full bg-tint" />}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export default CalendarMiniMonth
