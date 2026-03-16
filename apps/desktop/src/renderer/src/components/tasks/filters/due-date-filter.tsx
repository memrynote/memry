import { useState, useEffect } from 'react'
import { ChevronDown, Calendar as CalendarIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { DatePickerCalendar } from '@/components/tasks/date-picker-calendar'
import { cn } from '@/lib/utils'
import type {
  DueDateFilter as DueDateFilterType,
  DueDateFilterType as FilterType
} from '@/data/tasks-data'
import { dueDateFilterOptions } from '@/data/tasks-data'

// ============================================================================
// TYPES
// ============================================================================

interface DueDateFilterProps {
  value: DueDateFilterType
  onChange: (filter: DueDateFilterType) => void
  taskCountByDueDate?: Record<FilterType, number>
  className?: string
}

// ============================================================================
// PRESET DISPLAY CONFIG
// ============================================================================

const PRESET_OPTIONS: { value: FilterType; label: string; isOverdue?: boolean }[] = [
  { value: 'overdue', label: 'Overdue', isOverdue: true },
  { value: 'today', label: 'Today' },
  { value: 'tomorrow', label: 'Tomorrow' },
  { value: 'this-week', label: 'This Week' },
  { value: 'next-week', label: 'Next Week' },
  { value: 'none', label: 'No due date' }
]

// ============================================================================
// DUE DATE FILTER COMPONENT
// ============================================================================

export const DueDateFilter = ({
  value,
  onChange,
  taskCountByDueDate = {} as Record<FilterType, number>,
  className
}: DueDateFilterProps): React.JSX.Element => {
  const [isOpen, setIsOpen] = useState(false)
  const [localType, setLocalType] = useState<FilterType>(value.type)
  const [customStart, setCustomStart] = useState<Date | undefined>(value.customStart || undefined)
  const [customEnd, setCustomEnd] = useState<Date | undefined>(value.customEnd || undefined)

  useEffect(() => {
    setLocalType(value.type)
    setCustomStart(value.customStart || undefined)
    setCustomEnd(value.customEnd || undefined)
  }, [value])

  const hasSelection = value.type !== 'any'

  const getDisplayLabel = (): string => {
    if (value.type === 'any') return 'Due Date'
    if (value.type === 'custom' && value.customStart && value.customEnd) {
      const formatDate = (date: Date | string): string =>
        (date instanceof Date ? date : new Date(date)).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric'
        })
      return `${formatDate(value.customStart)} - ${formatDate(value.customEnd)}`
    }
    const option = dueDateFilterOptions.find((o) => o.value === value.type)
    return option?.label || 'Due Date'
  }

  const handleSelectType = (type: FilterType): void => {
    if (type === 'custom') return

    const isCurrentlySelected = localType === type
    if (isCurrentlySelected) {
      setLocalType('any')
      onChange({ type: 'any', customStart: null, customEnd: null })
    } else {
      setLocalType(type)
      onChange({ type, customStart: null, customEnd: null })
    }
  }

  const handleClear = (): void => {
    setLocalType('any')
    setCustomStart(undefined)
    setCustomEnd(undefined)
    onChange({ type: 'any', customStart: null, customEnd: null })
  }

  const handleOpenChange = (open: boolean): void => {
    if (open) {
      setLocalType(value.type)
      setCustomStart(value.customStart || undefined)
      setCustomEnd(value.customEnd || undefined)
    }
    setIsOpen(open)
  }

  const tryApplyCustomRange = (start?: Date, end?: Date): void => {
    if (start && end) {
      onChange({ type: 'custom', customStart: start, customEnd: end })
      setIsOpen(false)
    }
  }

  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn('h-9 gap-2', hasSelection && 'border-primary bg-primary/5', className)}
          aria-label="Filter by due date"
        >
          <span className="truncate max-w-32">{getDisplayLabel()}</span>
          <ChevronDown className="size-4 opacity-50 shrink-0" />
        </Button>
      </PopoverTrigger>

      <PopoverContent
        className="w-[280px] p-0 rounded-sm overflow-clip shadow-[0_4px_24px_rgba(0,0,0,0.08),0_1px_3px_rgba(0,0,0,0.04)]"
        align="start"
      >
        {/* Preset options */}
        <div className="flex flex-col py-2 border-b border-border">
          {PRESET_OPTIONS.map((option) => {
            const isSelected = localType === option.value
            const taskCount = taskCountByDueDate[option.value] || 0

            return (
              <button
                key={option.value}
                type="button"
                onClick={() => handleSelectType(option.value)}
                className={cn(
                  'flex items-center gap-2.5 py-2 px-4 transition-colors',
                  'hover:bg-accent focus:outline-none focus:bg-accent',
                  option.isOverdue &&
                    isSelected &&
                    'bg-red-50 dark:bg-red-500/10 hover:bg-red-50 dark:hover:bg-red-500/10'
                )}
              >
                <div
                  className="flex items-center justify-center rounded-sm shrink-0 size-4"
                  style={{
                    borderWidth: '1.5px',
                    borderStyle: 'solid',
                    borderColor: isSelected
                      ? option.isOverdue
                        ? '#E54D2E'
                        : 'var(--foreground)'
                      : 'var(--border)',
                    backgroundColor: isSelected
                      ? option.isOverdue
                        ? '#FEF0EE'
                        : 'var(--surface)'
                      : 'var(--card)'
                  }}
                >
                  {isSelected && (
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke={option.isOverdue ? '#E54D2E' : 'var(--foreground)'}
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </div>
                <span
                  className={cn(
                    'text-[13px] leading-4',
                    option.isOverdue && isSelected
                      ? 'font-medium text-[#E54D2E]'
                      : 'text-foreground',
                    option.value === 'none' && !isSelected && 'text-text-secondary'
                  )}
                >
                  {option.label}
                </span>
                <span
                  className={cn(
                    'text-[11px] ml-auto leading-[14px]',
                    option.isOverdue && isSelected
                      ? 'text-red-700 dark:text-red-400'
                      : 'text-text-tertiary'
                  )}
                >
                  {taskCount}
                </span>
              </button>
            )
          })}
        </div>

        {/* Custom range */}
        <div className="flex flex-col py-3 px-4 gap-2 border-b border-border">
          <span className="text-[11px] tracking-[0.05em] uppercase text-text-tertiary font-semibold leading-[14px]">
            Custom Range
          </span>
          <div className="flex items-center gap-2">
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="flex items-center grow shrink basis-0 rounded-sm py-1.5 px-2.5 gap-1.5 border border-border hover:border-text-tertiary transition-colors"
                >
                  <CalendarIcon className="size-3 text-text-tertiary" />
                  <span className="text-[12px] leading-4 text-text-tertiary">
                    {customStart
                      ? customStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                      : 'Start'}
                  </span>
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-[296px] p-3" align="start">
                <DatePickerCalendar
                  selected={customStart}
                  onSelect={(date) => {
                    const nextStart = date || undefined
                    const nextEnd =
                      nextStart && customEnd && customEnd < nextStart ? undefined : customEnd
                    setCustomStart(nextStart)
                    if (nextEnd !== customEnd) setCustomEnd(nextEnd)
                    tryApplyCustomRange(nextStart, nextEnd)
                  }}
                />
              </PopoverContent>
            </Popover>

            <span className="text-[12px] text-text-tertiary leading-4">—</span>

            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="flex items-center grow shrink basis-0 rounded-sm py-1.5 px-2.5 gap-1.5 border border-border hover:border-text-tertiary transition-colors"
                >
                  <CalendarIcon className="size-3 text-text-tertiary" />
                  <span className="text-[12px] leading-4 text-text-tertiary">
                    {customEnd
                      ? customEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                      : 'End'}
                  </span>
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-[296px] p-3" align="start">
                <DatePickerCalendar
                  selected={customEnd}
                  onSelect={(date) => {
                    const nextEnd = date || undefined
                    setCustomEnd(nextEnd)
                    tryApplyCustomRange(customStart, nextEnd)
                  }}
                  disabled={(date) => (customStart ? date < customStart : false)}
                />
              </PopoverContent>
            </Popover>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between py-2.5 px-4 bg-surface">
          <button
            type="button"
            onClick={handleClear}
            className="text-[12px] text-text-tertiary font-medium leading-4 hover:text-foreground transition-colors"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={() => setIsOpen(false)}
            className="flex items-center rounded-sm py-[5px] px-3.5 gap-1 bg-foreground hover:bg-foreground/80 transition-colors"
          >
            <span className="text-[12px] text-background font-semibold leading-4">Apply</span>
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export default DueDateFilter
