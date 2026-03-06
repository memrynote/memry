import { useState, useMemo } from 'react'
import { ChevronDown, Check } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { Status, RepeatFilterType, HasTimeFilterType } from '@/data/tasks-data'

// ============================================================================
// TYPES
// ============================================================================

interface MoreFiltersDropdownProps {
  // Status filter
  statuses?: Status[]
  selectedStatusIds: string[]
  onStatusChange: (statusIds: string[]) => void
  showStatusFilter?: boolean

  // Repeat type filter
  repeatType: RepeatFilterType
  onRepeatTypeChange: (type: RepeatFilterType) => void

  // Has time filter
  hasTime: HasTimeFilterType
  onHasTimeChange: (type: HasTimeFilterType) => void

  // Task counts
  taskCountByStatus?: Record<string, number>
  taskCountByRepeat?: { repeating: number; oneTime: number }
  taskCountByTime?: { withTime: number; withoutTime: number }

  className?: string
}

// ============================================================================
// REPEAT OPTIONS
// ============================================================================

const repeatOptions: { value: RepeatFilterType; label: string }[] = [
  { value: 'all', label: 'All tasks' },
  { value: 'repeating', label: 'Repeating only' },
  { value: 'one-time', label: 'One-time only' }
]

// ============================================================================
// TIME OPTIONS
// ============================================================================

const timeOptions: { value: HasTimeFilterType; label: string }[] = [
  { value: 'all', label: 'All tasks' },
  { value: 'with-time', label: 'With time set' },
  { value: 'without-time', label: 'Without time' }
]

// ============================================================================
// MORE FILTERS DROPDOWN COMPONENT
// ============================================================================

export const MoreFiltersDropdown = ({
  statuses = [],
  selectedStatusIds,
  onStatusChange,
  showStatusFilter = false,
  repeatType,
  onRepeatTypeChange,
  hasTime,
  onHasTimeChange,
  taskCountByStatus = {},
  taskCountByRepeat = { repeating: 0, oneTime: 0 },
  taskCountByTime = { withTime: 0, withoutTime: 0 },
  className
}: MoreFiltersDropdownProps): React.JSX.Element => {
  const [isOpen, setIsOpen] = useState(false)

  // Calculate active filter count
  const activeCount = useMemo(() => {
    let count = 0
    if (selectedStatusIds.length > 0) count++
    if (repeatType !== 'all') count++
    if (hasTime !== 'all') count++
    return count
  }, [selectedStatusIds, repeatType, hasTime])

  const hasSelection = activeCount > 0

  const handleToggleStatus = (statusId: string): void => {
    const nextStatusIds = selectedStatusIds.includes(statusId)
      ? selectedStatusIds.filter((id) => id !== statusId)
      : [...selectedStatusIds, statusId]
    onStatusChange(nextStatusIds)
  }

  const handleClear = (): void => {
    onStatusChange([])
    onRepeatTypeChange('all')
    onHasTimeChange('all')
  }

  const handleOpenChange = (open: boolean): void => {
    setIsOpen(open)
  }

  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn('h-9 gap-2', hasSelection && 'border-primary bg-primary/5', className)}
          aria-label="More filters"
        >
          <span>More</span>
          {hasSelection && (
            <span className="bg-primary text-primary-foreground text-xs px-1.5 py-0.5 rounded-full min-w-5 text-center">
              {activeCount}
            </span>
          )}
          <ChevronDown className="size-4 opacity-50" />
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-64 p-0" align="start">
        <div className="p-2 max-h-96 overflow-y-auto">
          {/* Status filter (only for Kanban view) */}
          {showStatusFilter && statuses.length > 0 && (
            <>
              <div className="text-xs font-medium text-muted-foreground px-2 py-1.5 uppercase">
                Status
              </div>
              {statuses.map((status) => {
                const isSelected = selectedStatusIds.includes(status.id)
                const taskCount = taskCountByStatus[status.id] || 0

                return (
                  <button
                    key={status.id}
                    type="button"
                    onClick={() => handleToggleStatus(status.id)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors',
                      'hover:bg-accent focus:outline-none focus:bg-accent',
                      isSelected && 'font-medium'
                    )}
                  >
                    <span className="flex items-center justify-center size-4">
                      {isSelected && <Check className="size-4 text-primary" />}
                    </span>
                    <span className="flex items-center gap-2 flex-1">
                      <span
                        className="size-2 rounded-full"
                        style={{ backgroundColor: status.color }}
                      />
                      <span>{status.name}</span>
                    </span>
                    <span className="text-xs text-text-tertiary">{taskCount}</span>
                  </button>
                )
              })}
              <div className="my-2 h-px bg-border" />
            </>
          )}

          {/* Repeat type filter */}
          <div className="text-xs font-medium text-muted-foreground px-2 py-1.5 uppercase">
            Repeat Type
          </div>
          {repeatOptions.map((option) => {
            const isSelected = repeatType === option.value
            let taskCount = 0
            if (option.value === 'repeating') taskCount = taskCountByRepeat.repeating
            if (option.value === 'one-time') taskCount = taskCountByRepeat.oneTime

            return (
              <button
                key={option.value}
                type="button"
                onClick={() => onRepeatTypeChange(option.value)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors',
                  'hover:bg-accent focus:outline-none focus:bg-accent',
                  isSelected && 'font-medium bg-accent'
                )}
              >
                <span className="flex items-center gap-2 flex-1">
                  <span
                    className={cn(
                      'size-2 rounded-full',
                      isSelected ? 'bg-primary' : 'bg-transparent'
                    )}
                  />
                  <span>{option.label}</span>
                </span>
                {option.value !== 'all' && (
                  <span className="text-xs text-text-tertiary">{taskCount}</span>
                )}
              </button>
            )
          })}

          <div className="my-2 h-px bg-border" />

          {/* Time filter */}
          <div className="text-xs font-medium text-muted-foreground px-2 py-1.5 uppercase">
            Time
          </div>
          {timeOptions.map((option) => {
            const isSelected = hasTime === option.value
            let taskCount = 0
            if (option.value === 'with-time') taskCount = taskCountByTime.withTime
            if (option.value === 'without-time') taskCount = taskCountByTime.withoutTime

            return (
              <button
                key={option.value}
                type="button"
                onClick={() => onHasTimeChange(option.value)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors',
                  'hover:bg-accent focus:outline-none focus:bg-accent',
                  isSelected && 'font-medium bg-accent'
                )}
              >
                <span className="flex items-center gap-2 flex-1">
                  <span
                    className={cn(
                      'size-2 rounded-full',
                      isSelected ? 'bg-primary' : 'bg-transparent'
                    )}
                  />
                  <span>{option.label}</span>
                </span>
                {option.value !== 'all' && (
                  <span className="text-xs text-text-tertiary">{taskCount}</span>
                )}
              </button>
            )
          })}

          <div className="my-2 h-px bg-border" />

          {/* Action buttons */}
          <div className="flex items-center justify-end px-2 py-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleClear}
              className="h-7 text-xs text-muted-foreground hover:text-foreground"
            >
              Clear All
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export default MoreFiltersDropdown
