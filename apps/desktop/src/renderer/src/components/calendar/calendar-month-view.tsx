import { CalendarItemChip } from './calendar-item-chip'
import { getMonthGridDays, isToday, isSameMonth, toLocalDateKey } from './date-utils'
import { cn } from '@/lib/utils'
import type { CalendarProjectionItem } from '@/services/calendar-service'

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MAX_VISIBLE_EVENTS = 3

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
  const gridDays = getMonthGridDays(anchorDate)

  return (
    <div className="flex h-full flex-col" data-testid="calendar-view" data-view="month">
      <div className="grid grid-cols-7 border-b border-[#E5E5E5] dark:border-neutral-800">
        {DAY_NAMES.map((name) => (
          <div
            key={name}
            className="bg-white px-2 py-2 text-center text-xs font-medium text-[#737373] dark:bg-neutral-950 dark:text-neutral-500"
          >
            {name}
          </div>
        ))}
      </div>

      <div className="grid flex-1 grid-cols-7">
        {gridDays.map((day) => {
          const inMonth = isSameMonth(day, anchorDate)
          const today = isToday(day)
          const dayNum = parseInt(day.slice(-2), 10)
          const dayItems = items.filter((item) => toLocalDateKey(item.startAt) === day)

          return (
            <div
              key={day}
              className={cn(
                'flex flex-col gap-1 border-b border-r border-[#E5E5E5] p-2 dark:border-neutral-800',
                inMonth
                  ? 'bg-white dark:bg-neutral-950'
                  : 'bg-[#FAFAFA] dark:bg-neutral-900/50'
              )}
            >
              <div className="mb-0.5">
                {today ? (
                  <span className="inline-flex size-6 items-center justify-center rounded-full bg-[#7F56D9] text-xs font-semibold text-white">
                    {dayNum}
                  </span>
                ) : (
                  <span
                    className={cn(
                      'inline-block text-xs font-medium leading-6',
                      inMonth
                        ? 'text-[#171717] dark:text-neutral-200'
                        : 'text-[#A3A3A3] dark:text-neutral-600'
                    )}
                  >
                    {dayNum}
                  </span>
                )}
              </div>

              <div className="flex flex-col gap-1">
                {dayItems.slice(0, MAX_VISIBLE_EVENTS).map((item) => (
                  <CalendarItemChip key={item.projectionId} item={item} onClick={onSelectItem} />
                ))}
                {dayItems.length > MAX_VISIBLE_EVENTS && (
                  <span className="text-xs font-semibold text-[#737373] dark:text-neutral-500">
                    {dayItems.length - MAX_VISIBLE_EVENTS} more...
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default CalendarMonthView
