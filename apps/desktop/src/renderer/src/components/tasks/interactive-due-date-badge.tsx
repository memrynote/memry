import * as React from 'react'
import { Repeat } from 'lucide-react'

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
    overdue:
      'text-red-600 dark:text-red-400 bg-red-500/[0.06] dark:bg-red-400/10 border-red-500/40 dark:border-red-400/25',
    today:
      'text-amber-600 dark:text-amber-500 bg-amber-500/[0.06] dark:bg-amber-400/10 border-amber-500/40 dark:border-amber-400/25',
    tomorrow:
      'text-blue-600 dark:text-blue-400 bg-blue-500/[0.06] dark:bg-blue-400/10 border-blue-500/40 dark:border-blue-400/25',
    upcoming:
      'text-indigo-600 dark:text-indigo-400 bg-indigo-500/[0.06] dark:bg-indigo-400/10 border-indigo-500/40 dark:border-indigo-400/25',
    later:
      'text-text-tertiary bg-foreground/[0.03] dark:bg-foreground/[0.06] border-foreground/10 dark:border-foreground/10',
    none: 'text-text-tertiary bg-foreground/[0.03] dark:bg-foreground/[0.06] border-foreground/10 dark:border-foreground/10'
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
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="shrink-0">
            <rect x="1.5" y="2" width="9" height="8.5" rx="1.25" stroke="currentColor" />
            <path d="M1.5 4.5h9" stroke="currentColor" />
          </svg>
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
