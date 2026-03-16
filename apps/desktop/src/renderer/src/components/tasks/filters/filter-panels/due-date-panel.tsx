import { useState, useMemo, useCallback } from 'react'

import { DatePickerCalendar } from '@/components/tasks/date-picker-calendar'
import type { DueDateFilter, DueDateFilterType } from '@/data/tasks-data'
import { cn } from '@/lib/utils'
import { BackButton } from './priority-panel'

const getNextMonday = (): Date => {
  const d = new Date()
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7))
  d.setHours(0, 0, 0, 0)
  return d
}

interface DueDatePanelProps {
  dueDate: DueDateFilter
  onSelectDueDate: (type: DueDateFilterType) => void
  onSelectCalendarDate: (day: number, year: number, month: number) => void
  onClearDueDate: () => void
  onGoBack: () => void
}

export function DueDatePanel({
  dueDate,
  onSelectDueDate,
  onSelectCalendarDate,
  onClearDueDate,
  onGoBack
}: DueDatePanelProps): React.JSX.Element {
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const now = new Date()
    return { year: now.getFullYear(), month: now.getMonth() }
  })

  const today = useMemo(() => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d
  }, [])

  const selectedCalendarDate = useMemo(() => {
    if (dueDate.type === 'today') {
      return { year: today.getFullYear(), month: today.getMonth(), day: today.getDate() }
    }
    if (dueDate.type === 'tomorrow') {
      const tmrw = new Date(today)
      tmrw.setDate(tmrw.getDate() + 1)
      return { year: tmrw.getFullYear(), month: tmrw.getMonth(), day: tmrw.getDate() }
    }
    if (dueDate.type === 'custom' && dueDate.customStart) {
      const d =
        dueDate.customStart instanceof Date ? dueDate.customStart : new Date(dueDate.customStart)
      return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate() }
    }
    return null
  }, [dueDate, today])

  const dueDatePresets = useMemo(() => {
    const tomorrow = new Date(today)
    tomorrow.setDate(tomorrow.getDate() + 1)
    const nextMon = getNextMonday()
    const fmt = (d: Date): string =>
      d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    return [
      { label: 'Today', date: fmt(today), type: 'today' as DueDateFilterType },
      { label: 'Tomorrow', date: fmt(tomorrow), type: 'tomorrow' as DueDateFilterType },
      { label: 'Next week', date: fmt(nextMon), type: 'next-week' as DueDateFilterType }
    ]
  }, [today])

  const handleSelectCalendarDate = useCallback(
    (date: Date | undefined) => {
      if (date) {
        onSelectCalendarDate(date.getDate(), date.getFullYear(), date.getMonth())
      }
    },
    [onSelectCalendarDate]
  )

  const prevMonth = useCallback(() => {
    setCalendarMonth((prev) => {
      const d = new Date(prev.year, prev.month - 1, 1)
      return { year: d.getFullYear(), month: d.getMonth() }
    })
  }, [])

  const nextMonth = useCallback(() => {
    setCalendarMonth((prev) => {
      const d = new Date(prev.year, prev.month + 1, 1)
      return { year: d.getFullYear(), month: d.getMonth() }
    })
  }, [])

  const calendarSelected = useMemo(() => {
    if (!selectedCalendarDate) return undefined
    return new Date(selectedCalendarDate.year, selectedCalendarDate.month, selectedCalendarDate.day)
  }, [selectedCalendarDate])

  return (
    <>
      <div className="flex items-center py-2 px-3 gap-1.5 border-b border-border">
        <BackButton onClick={onGoBack} />
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          className="text-muted-foreground"
        >
          <rect
            x="2"
            y="2.5"
            width="10"
            height="9.5"
            rx="1.5"
            stroke="currentColor"
            strokeWidth="1.1"
          />
          <path d="M2 5.5h10" stroke="currentColor" strokeWidth="1.1" />
        </svg>
        <span className="text-[12px] text-foreground font-medium leading-4">Due date</span>
      </div>
      <div className="flex flex-col p-1 border-b border-border">
        {dueDatePresets.map((preset) => {
          const active = dueDate.type === preset.type
          return (
            <button
              key={preset.type}
              type="button"
              onClick={() => onSelectDueDate(preset.type)}
              className={cn(
                'flex items-center rounded-[5px] py-1.5 px-2 gap-2 transition-colors',
                active ? 'bg-accent' : 'hover:bg-accent'
              )}
            >
              <span
                className={cn(
                  'text-[12px] leading-4',
                  active ? 'text-foreground' : 'text-text-secondary'
                )}
              >
                {preset.label}
              </span>
              <span className="text-[11px] ml-auto text-text-tertiary leading-3.5">
                {preset.date}
              </span>
            </button>
          )
        })}
        <button
          type="button"
          onClick={onClearDueDate}
          className="flex items-center rounded-[5px] py-1.5 px-2 gap-2 hover:bg-accent transition-colors"
        >
          <span className="text-[12px] text-destructive leading-4">Remove date</span>
        </button>
      </div>
      <div className="pt-2 pb-3 px-3">
        <div className="flex items-center justify-between py-0.5 mb-1.5">
          <button
            type="button"
            onClick={prevMonth}
            className="p-0.5 hover:bg-accent rounded transition-colors text-text-tertiary"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path
                d="M8.5 3.5L5 7l3.5 3.5"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <span className="text-[12px] text-foreground font-medium leading-4">
            {new Date(calendarMonth.year, calendarMonth.month).toLocaleDateString('en-US', {
              month: 'long'
            })}{' '}
            {calendarMonth.year}
          </span>
          <button
            type="button"
            onClick={nextMonth}
            className="p-0.5 hover:bg-accent rounded transition-colors text-text-tertiary"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path
                d="M5.5 3.5L9 7l-3.5 3.5"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
        <DatePickerCalendar
          selected={calendarSelected}
          onSelect={handleSelectCalendarDate}
          weekStartsOn={1}
          className="[&_[data-slot=weekday-header]]:h-6 [&_button]:!size-7 [&_button]:text-[11px]"
        />
      </div>
    </>
  )
}
