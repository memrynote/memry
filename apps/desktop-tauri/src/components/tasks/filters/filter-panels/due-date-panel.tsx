import { useMemo, useCallback } from 'react'

import { DatePickerContent } from '@/components/tasks/date-picker-content'
import type { DueDateFilter, DueDateFilterType } from '@/data/tasks-data'
import { BackButton } from './priority-panel'

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function getNextMonday(from: Date): Date {
  const d = new Date(from)
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
  const today = useMemo(() => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d
  }, [])

  const selectedDate = useMemo((): Date | null => {
    if (dueDate.type === 'today') return today
    if (dueDate.type === 'tomorrow') {
      const tmrw = new Date(today)
      tmrw.setDate(tmrw.getDate() + 1)
      return tmrw
    }
    if (dueDate.type === 'next-week') return getNextMonday(today)
    if (dueDate.type === 'custom' && dueDate.customStart) {
      return dueDate.customStart instanceof Date
        ? dueDate.customStart
        : new Date(dueDate.customStart)
    }
    return null
  }, [dueDate, today])

  const handleSelect = useCallback(
    (date: Date | null) => {
      if (!date) {
        onClearDueDate()
        return
      }

      if (isSameDay(date, today)) {
        onSelectDueDate('today')
        return
      }

      const tomorrow = new Date(today)
      tomorrow.setDate(tomorrow.getDate() + 1)
      if (isSameDay(date, tomorrow)) {
        onSelectDueDate('tomorrow')
        return
      }

      const nextMon = getNextMonday(today)
      if (isSameDay(date, nextMon)) {
        onSelectDueDate('next-week')
        return
      }

      onSelectCalendarDate(date.getDate(), date.getFullYear(), date.getMonth())
    },
    [today, onSelectDueDate, onSelectCalendarDate, onClearDueDate]
  )

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
        <span className="text-[13px] text-foreground font-medium leading-4">Due date</span>
      </div>
      <DatePickerContent selected={selectedDate} onSelect={handleSelect} />
    </>
  )
}
