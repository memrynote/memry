import { useState, useMemo, useCallback } from 'react'
import { getISOWeek } from 'date-fns'

import { ChevronLeft, ChevronRight } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { withAlpha } from '@/lib/color'

interface ActivityData {
  [dateISO: string]: number
}

interface DatePickerCalendarProps {
  selected?: Date
  onSelect: (date: Date | undefined) => void
  disabled?: (date: Date) => boolean
  weekStartsOn?: 0 | 1
  activityData?: ActivityData
  dayDots?: Record<string, string[]>
  hoveredEventColor?: string | null
  className?: string
  showWeekNumbers?: boolean
  onTodayClick?: () => void
}

export function getISOWeekNumber(date: Date): number {
  return getISOWeek(date)
}

const ACTIVITY_DOT_COLORS = [
  '',
  'bg-emerald-500/50',
  'bg-emerald-500/70',
  'bg-amber-500/80',
  'bg-amber-500'
] as const

function toISO(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

const WEEKDAYS_SUNDAY = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] as const
const WEEKDAYS_MONDAY = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'] as const

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate()
}

interface GridDate {
  date: Date
  isOutsideMonth: boolean
}

function getMonthGrid(year: number, month: number, weekStartsOn: 0 | 1 = 1): GridDate[][] {
  const firstDay = new Date(year, month, 1).getDay()
  const daysInMonth = getDaysInMonth(year, month)
  const startOffset = weekStartsOn === 1 ? (firstDay + 6) % 7 : firstDay
  const prevMonthDays = getDaysInMonth(year, month - 1)

  const weeks: GridDate[][] = []
  let currentWeek: GridDate[] = []

  for (let i = startOffset - 1; i >= 0; i--) {
    currentWeek.push({
      date: new Date(year, month - 1, prevMonthDays - i),
      isOutsideMonth: true
    })
  }

  for (let day = 1; day <= daysInMonth; day++) {
    currentWeek.push({ date: new Date(year, month, day), isOutsideMonth: false })
    if (currentWeek.length === 7) {
      weeks.push(currentWeek)
      currentWeek = []
    }
  }

  if (currentWeek.length > 0) {
    let nextDay = 1
    while (currentWeek.length < 7) {
      currentWeek.push({
        date: new Date(year, month + 1, nextDay++),
        isOutsideMonth: true
      })
    }
    weeks.push(currentWeek)
  }

  return weeks
}

const ChevronLeftIcon = (): React.JSX.Element => <ChevronLeft size={14} />

const ChevronRightIcon = (): React.JSX.Element => <ChevronRight size={14} />

export function DatePickerCalendar({
  selected,
  onSelect,
  disabled,
  weekStartsOn = 1,
  activityData,
  dayDots,
  hoveredEventColor,
  className,
  showWeekNumbers = false,
  onTodayClick
}: DatePickerCalendarProps): React.JSX.Element {
  const today = useMemo(() => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d
  }, [])

  const initialMonth = selected ?? today
  const [viewYear, setViewYear] = useState(initialMonth.getFullYear())
  const [viewMonth, setViewMonth] = useState(initialMonth.getMonth())

  const weeks = useMemo(
    () => getMonthGrid(viewYear, viewMonth, weekStartsOn),
    [viewYear, viewMonth, weekStartsOn]
  )

  const monthLabel = useMemo(
    () =>
      new Date(viewYear, viewMonth).toLocaleDateString('en-US', {
        month: 'long',
        year: 'numeric'
      }),
    [viewYear, viewMonth]
  )

  const goToPrevMonth = useCallback(() => {
    setViewMonth((m) => {
      if (m === 0) {
        setViewYear((y) => y - 1)
        return 11
      }
      return m - 1
    })
  }, [])

  const goToNextMonth = useCallback(() => {
    setViewMonth((m) => {
      if (m === 11) {
        setViewYear((y) => y + 1)
        return 0
      }
      return m + 1
    })
  }, [])

  const isViewingTodayMonth = viewYear === today.getFullYear() && viewMonth === today.getMonth()

  const goToToday = useCallback(() => {
    setViewYear(today.getFullYear())
    setViewMonth(today.getMonth())
    onTodayClick?.()
  }, [today, onTodayClick])

  const weekdays = weekStartsOn === 1 ? WEEKDAYS_MONDAY : WEEKDAYS_SUNDAY

  const handleDayClick = useCallback(
    (date: Date, isOutsideMonth: boolean) => {
      if (isOutsideMonth) {
        setViewYear(date.getFullYear())
        setViewMonth(date.getMonth())
      }
      onSelect(date)
    },
    [onSelect]
  )

  return (
    <div
      className={cn(
        '[font-synthesis:none] text-[12px] leading-4 flex flex-col pt-2 pb-3 gap-1.5',
        className
      )}
    >
      {/* Month navigation */}
      <div className="flex items-center justify-between py-0.5">
        <button
          type="button"
          onClick={goToPrevMonth}
          className="text-text-tertiary hover:text-text-secondary transition-colors focus-visible:outline-none rounded-sm"
          aria-label="Previous month"
        >
          <ChevronLeftIcon />
        </button>
        <span className="text-[12px] font-medium text-text-primary leading-4 select-none">
          {monthLabel}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={goToNextMonth}
            className="text-text-tertiary hover:text-text-secondary transition-colors focus-visible:outline-none rounded-sm"
            aria-label="Next month"
          >
            <ChevronRightIcon />
          </button>
          {onTodayClick && (
            <button
              type="button"
              onClick={goToToday}
              className="text-[10px] text-text-tertiary hover:text-text-secondary hover:bg-surface-active/50 transition-colors focus-visible:outline-none rounded-md px-1.5 py-0.5 font-medium select-none border border-border/60"
              aria-label="Go to today"
            >
              Today
            </button>
          )}
        </div>
      </div>

      {/* Weekday headers */}
      <div className="flex items-center">
        {showWeekNumbers && (
          <div className="w-6 shrink-0 text-[10px] text-center text-text-tertiary/40 font-medium leading-3 select-none">
            W
          </div>
        )}
        {weekdays.map((day) => (
          <div
            key={day}
            className="flex-1 min-w-0 text-[10px] text-center text-text-tertiary/60 font-medium leading-3 select-none"
          >
            {day}
          </div>
        ))}
      </div>

      {/* Day grid */}
      {weeks.map((week, wi) => (
        <div key={wi} className="flex items-center">
          {showWeekNumbers && (
            <div
              className="w-6 shrink-0 text-[10px] text-center text-text-tertiary/40 leading-3.5 select-none"
              aria-label={`Week ${getISOWeekNumber(week[0].date)}`}
            >
              {getISOWeekNumber(week[0].date)}
            </div>
          )}
          {week.map(({ date, isOutsideMonth }, di) => {
            const isToday = isSameDay(date, today)
            const isSelected = selected ? isSameDay(date, selected) : false
            const isDisabled = disabled?.(date) ?? false
            const isoKey = toISO(date)
            const activity = activityData ? (activityData[isoKey] ?? 0) : 0
            const dots = dayDots?.[isoKey]

            return (
              <button
                key={`${wi}-${di}`}
                type="button"
                onClick={() => !isDisabled && handleDayClick(date, isOutsideMonth)}
                disabled={isDisabled}
                className={cn(
                  'relative flex-1 min-w-0 aspect-square max-h-10 flex flex-col items-center justify-center gap-0.5 text-[11px] leading-3.5 transition-colors rounded-[5px]',
                  'focus-visible:outline-none',
                  isOutsideMonth &&
                    !isSelected &&
                    'text-text-tertiary/30 hover:text-text-tertiary/60 hover:bg-accent cursor-pointer',
                  !isOutsideMonth && isDisabled && 'text-text-tertiary/30 cursor-not-allowed',
                  !isOutsideMonth &&
                    !isDisabled &&
                    !isSelected &&
                    !isToday &&
                    date < today &&
                    'text-text-tertiary hover:bg-accent',
                  !isOutsideMonth &&
                    !isDisabled &&
                    !isSelected &&
                    !isToday &&
                    date >= today &&
                    'text-text-secondary hover:bg-accent',
                  isSelected && 'bg-primary text-primary-foreground font-semibold',
                  !isSelected &&
                    !isOutsideMonth &&
                    !isDisabled &&
                    isToday &&
                    'border border-foreground/15 text-text-primary font-medium'
                )}
                aria-label={date.toLocaleDateString('en-US', {
                  weekday: 'long',
                  month: 'long',
                  day: 'numeric'
                })}
                aria-pressed={isSelected}
                aria-disabled={isDisabled}
              >
                {isSelected && hoveredEventColor && (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 rounded-[5px]"
                    style={{ backgroundColor: withAlpha(hoveredEventColor, 0.2) }}
                  />
                )}
                <span className="relative">{date.getDate()}</span>
                {dots && dots.length > 0 ? (
                  <span className="relative inline-flex gap-[2px]" aria-hidden="true">
                    {dots.slice(0, 3).map((dotColor, i) => (
                      <span
                        key={`${dotColor}-${i}`}
                        className="size-1 rounded-full"
                        style={{ backgroundColor: dotColor }}
                      />
                    ))}
                  </span>
                ) : (
                  activity > 0 && (
                    <span
                      className={cn('relative size-1 rounded-full', ACTIVITY_DOT_COLORS[activity])}
                      aria-hidden="true"
                    />
                  )
                )}
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}
