import * as React from 'react'
import { Calendar, Repeat } from '@/lib/icons'

import { cn } from '@/lib/utils'
import { formatDueDate, formatDateShort, formatTime } from '@/lib/task-utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { DatePickerContent } from './date-picker-content'

interface InteractiveDueDateBadgeProps {
  dueDate: Date | null
  dueTime: string | null
  onDateChange: (date: Date | null) => void
  onTimeChange?: (time: string | null) => void
  isRepeating?: boolean
  variant?: 'default' | 'compact'
  fixedWidth?: boolean
  className?: string
}

export const InteractiveDueDateBadge = ({
  dueDate,
  dueTime,
  onDateChange,
  onTimeChange,
  isRepeating = false,
  variant: _variant = 'default',
  fixedWidth = false,
  className
}: InteractiveDueDateBadgeProps): React.JSX.Element => {
  const [isOpen, setIsOpen] = React.useState(false)

  const status = formatDueDate(dueDate, dueTime)

  const dateLabel = React.useMemo(() => {
    if (!dueDate) return 'No date'
    const short = formatDateShort(dueDate)
    return dueTime ? `${short} ${formatTime(dueTime)}` : short
  }, [dueDate, dueTime])

  const handleTriggerClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
  }

  const handleSelect = React.useCallback(
    (date: Date | null): void => {
      onDateChange(date)
      if (!date) onTimeChange?.(null)
      setIsOpen(false)
    },
    [onDateChange, onTimeChange]
  )

  const dateStatus = status?.status ?? 'none'

  const badgeStyles: Record<string, string> = {
    overdue: 'text-task-due-overdue bg-task-due-overdue-bg/60 border-task-due-overdue/40',
    today: 'text-task-due-today bg-task-due-today-bg/60 border-task-due-today/40',
    tomorrow: 'text-task-due-tomorrow bg-task-due-tomorrow-bg/60 border-task-due-tomorrow/40',
    upcoming: 'text-task-due-upcoming bg-task-due-upcoming/[0.06] border-task-due-upcoming/40',
    later: 'text-text-tertiary bg-foreground/[0.03] dark:bg-foreground/[0.06] border-foreground/10',
    none: 'text-text-tertiary bg-foreground/[0.03] dark:bg-foreground/[0.06] border-foreground/10'
  }

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild onClick={handleTriggerClick}>
        <button
          type="button"
          className={cn(
            'flex items-center gap-1.5 cursor-pointer transition-opacity rounded-[5px] py-[3px] px-2 border border-solid',
            'hover:opacity-80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            badgeStyles[dateStatus],
            fixedWidth && 'w-[110px] flex justify-end',
            className
          )}
          aria-label={`Due: ${dateLabel}. Click to change.`}
        >
          {isRepeating && <Repeat className="size-3 shrink-0" />}
          <Calendar size={12} className="shrink-0" />
          <div className="text-[12px] leading-4">{dateLabel}</div>
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-auto p-0 rounded-lg overflow-clip"
        align="end"
        onClick={handleTriggerClick}
      >
        <DatePickerContent
          selected={dueDate}
          onSelect={handleSelect}
          showRemoveDate={!!dueDate}
          time={dueTime}
          onTimeChange={onTimeChange}
        />
      </PopoverContent>
    </Popover>
  )
}
