import { useState, useMemo, useCallback } from 'react'

import { Clock, X } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { formatTime } from '@/lib/task-utils'
import { DatePickerCalendar } from './date-picker-calendar'

interface DatePickerContentProps {
  selected?: Date | null
  onSelect: (date: Date | null) => void
  showRemoveDate?: boolean
  time?: string | null
  onTimeChange?: (time: string | null) => void
  className?: string
}

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

function formatPresetDate(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function getDefaultTime(): string {
  const now = new Date()
  const hour = Math.min(now.getHours() + 1, 23)
  return `${hour.toString().padStart(2, '0')}:00`
}

const ClockIcon = (): React.JSX.Element => <Clock size={12} className="shrink-0" />

export function DatePickerContent({
  selected,
  onSelect,
  showRemoveDate = true,
  time,
  onTimeChange,
  className
}: DatePickerContentProps): React.JSX.Element {
  const [editing, setEditing] = useState(false)

  const today = useMemo(() => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d
  }, [])

  const presets = useMemo(() => {
    const tomorrow = new Date(today)
    tomorrow.setDate(tomorrow.getDate() + 1)
    const nextMon = getNextMonday(today)
    return [
      { label: 'Today', date: today, dateLabel: formatPresetDate(today) },
      { label: 'Tomorrow', date: tomorrow, dateLabel: formatPresetDate(tomorrow) },
      { label: 'Next week', date: nextMon, dateLabel: formatPresetDate(nextMon) }
    ]
  }, [today])

  const handleCalendarSelect = useCallback(
    (date: Date | undefined) => {
      onSelect(date ?? null)
    },
    [onSelect]
  )

  const handleAddTime = useCallback(() => {
    const defaultTime = getDefaultTime()
    onTimeChange?.(defaultTime)
    setEditing(true)
  }, [onTimeChange])

  const handleClearTime = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onTimeChange?.(null)
      setEditing(false)
    },
    [onTimeChange]
  )

  const showTimeSection = !!onTimeChange && !!selected

  return (
    <div className={cn('flex flex-col', className)}>
      <div className="flex flex-col border-b border-border p-1">
        {presets.map((preset) => {
          const isActive = selected ? isSameDay(selected, preset.date) : false
          return (
            <button
              key={preset.label}
              type="button"
              onClick={() => onSelect(preset.date)}
              className={cn(
                'flex items-center rounded-[5px] py-1.5 px-2 gap-2 transition-colors',
                isActive ? 'bg-accent' : 'hover:bg-accent'
              )}
            >
              <span
                className={cn(
                  'text-[12px] leading-4',
                  isActive ? 'text-foreground' : 'text-text-secondary'
                )}
              >
                {preset.label}
              </span>
              <span className="text-[11px] ml-auto text-text-tertiary leading-3.5">
                {preset.dateLabel}
              </span>
            </button>
          )
        })}
        {showRemoveDate && (
          <button
            type="button"
            onClick={() => onSelect(null)}
            className="flex items-center rounded-[5px] py-1.5 px-2 gap-2 hover:bg-accent transition-colors"
          >
            <span className="text-[12px] text-destructive leading-4">Remove date</span>
          </button>
        )}
      </div>
      <DatePickerCalendar
        selected={selected ?? undefined}
        onSelect={handleCalendarSelect}
        weekStartsOn={1}
        className="px-3"
      />
      {showTimeSection && (
        <div className="flex items-center border-t border-border p-1">
          {time || editing ? (
            <>
              <div className="flex items-center flex-1 rounded-[5px] py-1 px-2 gap-2">
                <ClockIcon />
                <input
                  type="time"
                  value={time ?? ''}
                  onChange={(e) => onTimeChange?.(e.target.value || null)}
                  className={cn(
                    'bg-transparent text-[12px] leading-4 text-foreground',
                    'focus:outline-none [&::-webkit-calendar-picker-indicator]:hidden'
                  )}
                  autoFocus={editing}
                  onBlur={() => setEditing(false)}
                />
                <span className="text-[11px] text-text-tertiary leading-3.5">
                  {time ? formatTime(time) : ''}
                </span>
              </div>
              <button
                type="button"
                onClick={handleClearTime}
                className="rounded-[5px] p-1.5 text-text-tertiary hover:text-destructive hover:bg-accent transition-colors"
                aria-label="Clear time"
              >
                <X size={10} />
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={handleAddTime}
              className="flex items-center flex-1 rounded-[5px] py-1.5 px-2 gap-2 hover:bg-accent transition-colors"
            >
              <ClockIcon />
              <span className="text-[12px] text-text-tertiary leading-4">Add time</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}
