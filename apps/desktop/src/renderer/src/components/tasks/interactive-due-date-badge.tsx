import * as React from 'react'
import { Repeat } from 'lucide-react'

import { cn } from '@/lib/utils'
import { formatDueDate } from '@/lib/task-utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { DatePickerCalendar } from './date-picker-calendar'

interface InteractiveDueDateBadgeProps {
  dueDate: Date | null
  dueTime: string | null
  onDateChange: (date: Date | null) => void
  isRepeating?: boolean
  variant?: 'default' | 'compact'
  fixedWidth?: boolean
  className?: string
}

export const InteractiveDueDateBadge = ({
  dueDate,
  dueTime,
  onDateChange,
  isRepeating = false,
  variant: _variant = 'default',
  fixedWidth = false,
  className
}: InteractiveDueDateBadgeProps): React.JSX.Element => {
  const [isOpen, setIsOpen] = React.useState(false)

  const formatted = formatDueDate(dueDate, dueTime)

  const handleTriggerClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
  }

  const handleDateSelect = (date: Date | undefined): void => {
    onDateChange(date || null)
    setIsOpen(false)
  }

  const handleQuickDate =
    (days: number) =>
    (e: React.MouseEvent): void => {
      e.stopPropagation()
      const targetDate = new Date()
      targetDate.setDate(targetDate.getDate() + days)
      targetDate.setHours(0, 0, 0, 0)
      onDateChange(targetDate)
      setIsOpen(false)
    }

  const handleRemoveDate = (e: React.MouseEvent): void => {
    e.stopPropagation()
    onDateChange(null)
    setIsOpen(false)
  }

  const isOverdue = formatted?.status === 'overdue'
  const isToday = formatted?.status === 'today'

  const dateColorClass = isOverdue
    ? 'text-red-600 dark:text-red-400'
    : isToday
      ? 'text-amber-600 dark:text-amber-500'
      : 'text-text-tertiary'

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild onClick={handleTriggerClick}>
        <button
          type="button"
          className={cn(
            'flex items-center gap-1 cursor-pointer transition-opacity rounded-sm',
            'hover:opacity-80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            dateColorClass,
            fixedWidth && 'w-[110px] flex justify-end',
            className
          )}
          aria-label={`Due: ${formatted?.label || 'no date'}. Click to change.`}
        >
          {isRepeating && <Repeat className="size-3 shrink-0" />}
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="shrink-0">
            <path
              d="M4 1v2M8 1v2M1.5 5h9M2 2.5h8a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1z"
              stroke="currentColor"
              strokeWidth="1.1"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <div className="text-[11px] leading-3.5">{formatted?.label || 'No date'}</div>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[296px] p-3" align="end" onClick={handleTriggerClick}>
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleQuickDate(0)}
              className={cn(
                'flex-1 rounded-sm py-1.5 text-xs font-medium transition-colors',
                'hover:bg-accent',
                isToday ? 'bg-accent text-foreground' : 'text-muted-foreground'
              )}
            >
              Today
            </button>
            <button
              type="button"
              onClick={handleQuickDate(1)}
              className={cn(
                'flex-1 rounded-sm py-1.5 text-xs font-medium transition-colors',
                'hover:bg-accent',
                formatted?.status === 'tomorrow'
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground'
              )}
            >
              Tomorrow
            </button>
            <button
              type="button"
              onClick={handleQuickDate(7)}
              className="flex-1 rounded-sm py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent"
            >
              +1 Week
            </button>
          </div>

          <div className="h-px bg-border" />

          <DatePickerCalendar selected={dueDate || undefined} onSelect={handleDateSelect} />

          {dueDate && (
            <>
              <div className="h-px bg-border" />
              <button
                type="button"
                onClick={handleRemoveDate}
                className="w-full rounded-sm py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
              >
                Remove due date
              </button>
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
