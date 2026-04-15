import { useEffect, useMemo, useRef, useState } from 'react'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { formatTimeOfDay } from '@/lib/time-format'
import { cn } from '@/lib/utils'
import {
  getMonthGridDaysMondayStart,
  isToday,
  isSameMonth,
  parseLocalDate,
  toLocalDateKey,
  toLocalDateString
} from './date-utils'
import type { CalendarProjectionItem } from '@/services/calendar-service'
import type { CalendarWorkspaceView } from './calendar-toolbar'

const DAY_HEADERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']
const CLICK_DELAY_MS = 250

const DOT_COLORS: Record<CalendarProjectionItem['visualType'], string> = {
  event: 'bg-violet-400',
  task: 'bg-blue-400',
  reminder: 'bg-green-400',
  snooze: 'bg-orange-400',
  external_event: 'bg-neutral-400'
}

function formatPopoverDate(day: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  }).format(parseLocalDate(day))
}

interface CalendarYearViewProps {
  anchorDate: string
  items: CalendarProjectionItem[]
  onSelectItem?: (item: CalendarProjectionItem) => void
  onViewChange?: (view: CalendarWorkspaceView) => void
  onAnchorChange?: (date: string) => void
}

export function CalendarYearView({
  anchorDate,
  items,
  onSelectItem,
  onViewChange,
  onAnchorChange
}: CalendarYearViewProps): React.JSX.Element {
  const {
    settings: { clockFormat }
  } = useGeneralSettings()
  const [popoverDay, setPopoverDay] = useState<string | null>(null)
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function formatPopoverTime(item: CalendarProjectionItem): string {
    if (item.isAllDay) return 'all-day'
    return formatTimeOfDay(new Date(item.startAt), clockFormat)
  }

  useEffect(() => {
    return () => {
      if (clickTimerRef.current) clearTimeout(clickTimerRef.current)
    }
  }, [])

  const year = parseLocalDate(anchorDate).getFullYear()

  const months = useMemo(
    () =>
      Array.from({ length: 12 }, (_, i) => {
        const monthDate = new Date(year, i, 1)
        const monthAnchor = toLocalDateString(monthDate)
        return {
          monthAnchor,
          label: new Intl.DateTimeFormat(undefined, { month: 'long' }).format(monthDate),
          gridDays: getMonthGridDaysMondayStart(monthAnchor)
        }
      }),
    [year]
  )

  const itemsByDay = useMemo(() => {
    const map = new Map<string, CalendarProjectionItem[]>()
    for (const item of items) {
      const key = toLocalDateKey(item.startAt)
      const existing = map.get(key)
      if (existing) {
        existing.push(item)
      } else {
        map.set(key, [item])
      }
    }
    return map
  }, [items])

  function handleDayClick(day: string): void {
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
    }
    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null
      setPopoverDay((current) => (current === day ? null : day))
    }, CLICK_DELAY_MS)
  }

  function handleDayDoubleClick(day: string): void {
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
    }
    setPopoverDay(null)
    onAnchorChange?.(day)
    onViewChange?.('month')
  }

  const popoverItems = popoverDay ? (itemsByDay.get(popoverDay) ?? []) : []

  return (
    <Popover
      open={popoverDay !== null}
      onOpenChange={(open) => {
        if (!open) setPopoverDay(null)
      }}
    >
      <section
        className="h-full overflow-y-auto px-3 py-3 @lg:px-6 @lg:py-4 @3xl:px-8 @3xl:py-6"
        data-testid="calendar-view"
        data-view="year"
      >
        <div className="grid grid-cols-2 gap-4 @lg:grid-cols-3 @lg:gap-x-6 @lg:gap-y-6 @3xl:grid-cols-4 @3xl:gap-x-10 @3xl:gap-y-8">
          {months.map((month) => (
            <div key={month.monthAnchor}>
              <h3 className="mb-2 text-sm font-semibold text-red-400">{month.label}</h3>

              <div className="mb-1 grid grid-cols-7">
                {DAY_HEADERS.map((header, i) => (
                  <span
                    key={i}
                    className="py-0.5 text-center text-xs font-medium text-muted-foreground"
                  >
                    {header}
                  </span>
                ))}
              </div>

              <div className="grid grid-cols-7">
                {month.gridDays.map((day) => {
                  const inMonth = isSameMonth(day, month.monthAnchor)
                  const today = isToday(day)
                  const dayNum = parseInt(day.slice(-2), 10)
                  const hasEvents = itemsByDay.has(day)
                  const isActive = popoverDay === day

                  const button = (
                    <button
                      key={day}
                      type="button"
                      className="relative flex flex-col items-center py-0.5"
                      onClick={() => handleDayClick(day)}
                      onDoubleClick={() => handleDayDoubleClick(day)}
                      aria-label={formatPopoverDate(day)}
                    >
                      <span
                        className={cn(
                          'flex size-5 items-center justify-center rounded-full text-[10px] @lg:size-7 @lg:text-xs',
                          today && 'bg-red-500/90 font-semibold text-white',
                          !today && inMonth && 'text-foreground hover:bg-surface-active',
                          !today && !inMonth && 'text-muted-foreground'
                        )}
                      >
                        {dayNum}
                      </span>
                      {hasEvents && !today && (
                        <span className="absolute bottom-0 size-1 rounded-full bg-red-400" />
                      )}
                    </button>
                  )

                  if (isActive) {
                    return (
                      <PopoverAnchor key={day} asChild>
                        {button}
                      </PopoverAnchor>
                    )
                  }

                  return button
                })}
              </div>
            </div>
          ))}
        </div>
      </section>

      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={4}
        className="w-64 rounded-xl border-border bg-popover p-3 shadow-xl"
      >
        {popoverDay && (
          <>
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              {formatPopoverDate(popoverDay)}
            </p>
            {popoverItems.length === 0 ? (
              <p className="text-xs text-muted-foreground">No events</p>
            ) : (
              <div className="flex flex-col gap-1">
                {popoverItems.map((item) => (
                  <button
                    key={item.projectionId}
                    type="button"
                    className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-surface-active"
                    onClick={() => onSelectItem?.(item)}
                  >
                    <span
                      className={cn('size-2 shrink-0 rounded-full', DOT_COLORS[item.visualType])}
                      style={item.source.color ? { backgroundColor: item.source.color } : undefined}
                    />
                    <span className="flex-1 truncate text-xs text-foreground">{item.title}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatPopoverTime(item)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

export default CalendarYearView
