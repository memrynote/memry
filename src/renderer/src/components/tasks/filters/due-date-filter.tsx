import { useState, useEffect, useMemo } from 'react'
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
  const [showCustom, setShowCustom] = useState(value.type === 'custom')

  // Sync local state when props change
  useEffect(() => {
    setLocalType(value.type)
    setCustomStart(value.customStart || undefined)
    setCustomEnd(value.customEnd || undefined)
    setShowCustom(value.type === 'custom')
  }, [value])

  const hasSelection = value.type !== 'any'

  const getDisplayLabel = (): string => {
    if (value.type === 'any') return 'Due Date'
    if (value.type === 'custom' && value.customStart && value.customEnd) {
      const formatDate = (date: Date): string =>
        date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      return `${formatDate(value.customStart)} - ${formatDate(value.customEnd)}`
    }
    const option = dueDateFilterOptions.find((o) => o.value === value.type)
    return option?.label || 'Due Date'
  }

  const handleSelectType = (type: FilterType): void => {
    if (type === 'custom') {
      setShowCustom(true)
      setLocalType(type)
    } else {
      setLocalType(type)
      setShowCustom(false)
      onChange({ type, customStart: null, customEnd: null })
      setIsOpen(false)
    }
  }
  const tryApplyCustomRange = (start?: Date, end?: Date): void => {
    if (start && end) {
      onChange({
        type: 'custom',
        customStart: start,
        customEnd: end
      })
      setIsOpen(false)
    }
  }

  const handleOpenChange = (open: boolean): void => {
    if (open) {
      setLocalType(value.type)
      setCustomStart(value.customStart || undefined)
      setCustomEnd(value.customEnd || undefined)
      setShowCustom(value.type === 'custom')
    }
    setIsOpen(open)
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

      <PopoverContent className={cn('p-0', showCustom ? 'w-auto' : 'w-56')} align="start">
        {!showCustom ? (
          <div className="p-2">
            {/* Preset options */}
            <div className="max-h-80 overflow-y-auto">
              {dueDateFilterOptions.map((option, index) => {
                const isSelected = localType === option.value
                const taskCount = taskCountByDueDate[option.value] || 0

                // Add separator before "Custom range"
                const showSeparator =
                  index > 0 &&
                  (option.value === 'custom' ||
                    (index === 2 && dueDateFilterOptions[index - 1]?.value !== 'custom'))

                return (
                  <div key={option.value}>
                    {showSeparator && index === 2 && <div className="my-2 h-px bg-border" />}
                    <button
                      type="button"
                      onClick={() => handleSelectType(option.value)}
                      className={cn(
                        'flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm transition-colors',
                        'hover:bg-accent focus:outline-none focus:bg-accent',
                        isSelected && 'font-medium bg-accent'
                      )}
                    >
                      <span className="flex items-center gap-2">
                        <span
                          className={cn(
                            'size-2 rounded-full',
                            isSelected ? 'bg-primary' : 'bg-transparent'
                          )}
                        />
                        <span>{option.label}</span>
                      </span>
                      {option.value !== 'any' &&
                        option.value !== 'none' &&
                        option.value !== 'custom' && (
                          <span className="text-xs text-text-tertiary">{taskCount}</span>
                        )}
                    </button>
                    {option.value === 'custom' && index > 0 && (
                      <div className="my-2 h-px bg-border" />
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        ) : (
          <div className="p-4">
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm font-medium">Custom Range</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowCustom(false)}
                className="h-7 text-xs"
              >
                Back
              </Button>
            </div>

            <div className="space-y-4">
              {/* From date */}
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">From</label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className={cn(
                        'w-full justify-start text-left font-normal',
                        !customStart && 'text-muted-foreground'
                      )}
                    >
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {customStart
                        ? customStart.toLocaleDateString('en-US', {
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric'
                          })
                        : 'Select date'}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[296px] p-3" align="start">
                    <DatePickerCalendar
                      selected={customStart}
                      onSelect={(date) => {
                        const nextStart = date || undefined
                        const nextEnd =
                          nextStart && customEnd && customEnd < nextStart ? undefined : customEnd
                        setCustomStart(nextStart)
                        if (nextEnd !== customEnd) {
                          setCustomEnd(nextEnd)
                        }
                        tryApplyCustomRange(nextStart, nextEnd)
                      }}
                    />
                  </PopoverContent>
                </Popover>
              </div>

              {/* To date */}
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">To</label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className={cn(
                        'w-full justify-start text-left font-normal',
                        !customEnd && 'text-muted-foreground'
                      )}
                    >
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {customEnd
                        ? customEnd.toLocaleDateString('en-US', {
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric'
                          })
                        : 'Select date'}
                    </Button>
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
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

export default DueDateFilter
