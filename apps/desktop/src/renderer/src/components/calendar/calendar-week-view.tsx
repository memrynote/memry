import { useMemo } from 'react'
import { CalendarItemChip } from './calendar-item-chip'
import { addLocalDays, getStartOfWeek, isToday, toLocalDateKey } from './date-utils'
import { cn } from '@/lib/utils'
import type { CalendarProjectionItem } from '@/services/calendar-service'

const HOUR_HEIGHT = 96
const HOURS = Array.from({ length: 24 }, (_, i) => i)
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const GRID_LINE_BG =
  'repeating-linear-gradient(to bottom, transparent, transparent 47px, var(--grid-line-color) 47px, var(--grid-line-color) 48px)'

function formatHour(hour: number): string {
  if (hour === 0) return '12 AM'
  if (hour < 12) return `${hour} AM`
  if (hour === 12) return '12 PM'
  return `${hour - 12} PM`
}

function getEventPosition(item: CalendarProjectionItem): { top: number; height: number } {
  const start = new Date(item.startAt)
  const top = start.getHours() * HOUR_HEIGHT + start.getMinutes() * (HOUR_HEIGHT / 60)
  const endMs = item.endAt ? new Date(item.endAt).getTime() : start.getTime() + 3600000
  const durationMinutes = (endMs - start.getTime()) / 60000
  return { top, height: Math.max(durationMinutes * (HOUR_HEIGHT / 60), 24) }
}

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
  const weekStart = getStartOfWeek(anchorDate)
  const days = Array.from({ length: 7 }, (_, i) => addLocalDays(weekStart, i))

  const currentTimeOffset = useMemo(() => {
    const now = new Date()
    return now.getHours() * HOUR_HEIGHT + now.getMinutes() * (HOUR_HEIGHT / 60)
  }, [])

  return (
    <div className="flex h-full flex-col" data-testid="calendar-view" data-view="week">
      <div className="grid grid-cols-[72px_repeat(7,1fr)] border-b border-border">
        <div />
        {days.map((day, i) => {
          const today = isToday(day)
          const dayNum = parseInt(day.slice(-2), 10)
          return (
            <div
              key={day}
              className="flex items-center justify-center gap-1 bg-background px-2 py-2"
            >
              <span className="text-xs font-medium text-muted-foreground">
                {DAY_NAMES[i]}
              </span>
              {today ? (
                <span className="inline-flex size-6 items-center justify-center rounded-full bg-tint text-xs font-semibold text-tint-foreground">
                  {dayNum}
                </span>
              ) : (
                <span className="text-xs font-semibold text-foreground">
                  {dayNum}
                </span>
              )}
            </div>
          )
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          className="relative grid grid-cols-[72px_repeat(7,1fr)] [--grid-line-color:var(--border)]"
          style={{ height: HOUR_HEIGHT * 24 }}
        >
          <div className="border-r border-border">
            {HOURS.map((hour) => (
              <div
                key={hour}
                className="flex justify-end pr-3 pt-1"
                style={{ height: HOUR_HEIGHT }}
              >
                <span className="text-xs font-medium text-muted-foreground">
                  {formatHour(hour)}
                </span>
              </div>
            ))}
          </div>

          {days.map((day) => {
            const today = isToday(day)
            const dayItems = items.filter(
              (item) => !item.isAllDay && toLocalDateKey(item.startAt) === day
            )

            return (
              <div
                key={day}
                className={cn(
                  'relative border-r border-border',
                  'bg-background'
                )}
                style={{ backgroundImage: GRID_LINE_BG }}
              >
                {dayItems.map((item) => {
                  const pos = getEventPosition(item)
                  return (
                    <div
                      key={item.projectionId}
                      className="absolute left-0.5 right-0.5 z-10"
                      style={{ top: pos.top, height: pos.height }}
                    >
                      <CalendarItemChip item={item} onClick={onSelectItem} />
                    </div>
                  )
                })}

                {today && (
                  <div
                    className="absolute left-0 right-0 z-20 flex items-center"
                    style={{ top: currentTimeOffset }}
                  >
                    <div className="size-2 rounded-full bg-tint" />
                    <div className="h-0.5 flex-1 bg-tint" />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export default CalendarWeekView
