import { useState, useMemo, useCallback } from 'react'

import { ChevronLeft, ChevronRight } from '@/lib/icons'
import { cn } from '@/lib/utils'

interface DatePickerCalendarProps {
  selected?: Date
  onSelect: (date: Date | undefined) => void
  disabled?: (date: Date) => boolean
  weekStartsOn?: 0 | 1
  className?: string
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
  className
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

  const weekdays = weekStartsOn === 1 ? WEEKDAYS_MONDAY : WEEKDAYS_SUNDAY

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
        <button
          type="button"
          onClick={goToNextMonth}
          className="text-text-tertiary hover:text-text-secondary transition-colors focus-visible:outline-none rounded-sm"
          aria-label="Next month"
        >
          <ChevronRightIcon />
        </button>
      </div>

      {/* Weekday headers */}
      <div className="flex items-center">
        {weekdays.map((day) => (
          <div
            key={day}
            className="text-[10px] w-[30px] text-center text-text-tertiary/60 font-medium leading-3 shrink-0 select-none"
          >
            {day}
          </div>
        ))}
      </div>

      {/* Day grid */}
      {weeks.map((week, wi) => (
        <div key={wi} className="flex items-center">
          {week.map(({ date, isOutsideMonth }, di) => {
            const isToday = isSameDay(date, today)
            const isSelected = !isOutsideMonth && selected ? isSameDay(date, selected) : false
            const isDisabled = isOutsideMonth || (disabled?.(date) ?? false)

            return (
              <button
                key={`${wi}-${di}`}
                type="button"
                onClick={() => !isDisabled && onSelect(date)}
                disabled={isDisabled}
                className={cn(
                  'w-[30px] h-[26px] flex items-center justify-center shrink-0 text-[11px] leading-3.5 transition-colors rounded-[5px]',
                  'focus-visible:outline-none',
                  isOutsideMonth && 'text-text-tertiary/30 cursor-default',
                  !isOutsideMonth && isDisabled && 'text-text-tertiary/30 cursor-not-allowed',
                  !isDisabled &&
                    !isSelected &&
                    !isToday &&
                    date < today &&
                    'text-text-tertiary hover:bg-accent',
                  !isDisabled &&
                    !isSelected &&
                    !isToday &&
                    date >= today &&
                    'text-text-secondary hover:bg-accent',
                  !isDisabled && isSelected && 'bg-primary text-primary-foreground font-semibold',
                  !isDisabled &&
                    !isSelected &&
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
                {date.getDate()}
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}
