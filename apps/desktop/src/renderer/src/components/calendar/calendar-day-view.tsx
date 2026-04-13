import { useMemo, useState } from 'react'
import { CalendarItemChip } from './calendar-item-chip'
import { CalendarMiniMonth } from './calendar-mini-month'
import { isToday, toLocalDateKey } from './date-utils'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { formatHour } from '@/lib/time-format'
import type { CalendarProjectionItem } from '@/services/calendar-service'

const HOUR_HEIGHT = 96
const HOURS = Array.from({ length: 24 }, (_, i) => i)
const GRID_LINE_BG =
  'repeating-linear-gradient(to bottom, transparent, transparent 47px, var(--grid-line-color) 47px, var(--grid-line-color) 48px)'

function getEventPosition(item: CalendarProjectionItem): { top: number; height: number } {
  const start = new Date(item.startAt)
  const top = start.getHours() * HOUR_HEIGHT + start.getMinutes() * (HOUR_HEIGHT / 60)
  const endMs = item.endAt ? new Date(item.endAt).getTime() : start.getTime() + 3600000
  const durationMinutes = (endMs - start.getTime()) / 60000
  return { top, height: Math.max(durationMinutes * (HOUR_HEIGHT / 60), 24) }
}

interface CalendarDayViewProps {
  anchorDate: string
  items: CalendarProjectionItem[]
  onSelectItem?: (item: CalendarProjectionItem) => void
  onAnchorChange?: (date: string) => void
}

export function CalendarDayView({
  anchorDate,
  items,
  onSelectItem,
  onAnchorChange
}: CalendarDayViewProps): React.JSX.Element {
  const { settings: { clockFormat } } = useGeneralSettings()
  const [miniMonthAnchor, setMiniMonthAnchor] = useState(anchorDate)
  const today = isToday(anchorDate)
  const dayItems = items.filter((item) => toLocalDateKey(item.startAt) === anchorDate)
  const timedItems = dayItems.filter((item) => !item.isAllDay)

  const currentTimeOffset = useMemo(() => {
    const now = new Date()
    return now.getHours() * HOUR_HEIGHT + now.getMinutes() * (HOUR_HEIGHT / 60)
  }, [])

  return (
    <div className="flex h-full" data-testid="calendar-view" data-view="day">
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className="relative flex [--grid-line-color:var(--border)]" style={{ height: HOUR_HEIGHT * 24 }}>
          <div className="w-[48px] shrink-0 @xl:w-[72px]">
            {HOURS.map((hour) => (
              <div
                key={hour}
                className="flex items-start justify-end pr-3"
                style={{ height: HOUR_HEIGHT }}
              >
                <span className="text-xs font-medium text-muted-foreground -translate-y-1/2">
                  {formatHour(hour, clockFormat)}
                </span>
              </div>
            ))}
          </div>

          <div
            className="relative flex-1"
            style={{ backgroundImage: GRID_LINE_BG }}
          >
            {timedItems.map((item) => {
              const pos = getEventPosition(item)
              return (
                <div
                  key={item.projectionId}
                  className="absolute left-0.5 right-0.5 z-10 @xl:left-1 @xl:right-1"
                  style={{ top: pos.top, height: pos.height }}
                >
                  <CalendarItemChip item={item} clockFormat={clockFormat} onClick={onSelectItem} />
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
        </div>
      </div>

      <div className="hidden w-[328px] shrink-0 flex-col border-l border-border @3xl:flex">
        <CalendarMiniMonth
          anchorDate={miniMonthAnchor}
          items={items}
          onDateSelect={(date) => onAnchorChange?.(date)}
          onMonthChange={setMiniMonthAnchor}
        />

        <div className="flex flex-col gap-3 border-t border-border px-6 py-5">
          <h3 className="text-sm font-semibold text-foreground">
            Today&apos;s events
          </h3>
          {dayItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">No events scheduled.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {dayItems.map((item) => (
                <CalendarItemChip key={item.projectionId} item={item} clockFormat={clockFormat} onClick={onSelectItem} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default CalendarDayView
