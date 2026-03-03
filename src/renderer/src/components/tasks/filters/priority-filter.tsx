import { useState } from 'react'
import { ChevronDown, Check } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { type Priority, priorityConfig } from '@/data/sample-tasks'

// ============================================================================
// TYPES
// ============================================================================

interface PriorityFilterProps {
  selectedPriorities: Priority[]
  onChange: (priorities: Priority[]) => void
  taskCountByPriority?: Record<Priority, number>
  className?: string
}

interface PriorityOption {
  value: Priority
  label: string
  color: string | null
}

// ============================================================================
// PRIORITY OPTIONS
// ============================================================================

const priorityOptions: PriorityOption[] = [
  { value: 'urgent', label: 'Urgent', color: priorityConfig.urgent.color },
  { value: 'high', label: 'High', color: priorityConfig.high.color },
  { value: 'medium', label: 'Medium', color: priorityConfig.medium.color },
  { value: 'low', label: 'Low', color: priorityConfig.low.color },
  { value: 'none', label: 'None', color: null }
]

// Quick presets
const quickPresets = [
  { id: 'high-urgent', label: 'High & Urgent', priorities: ['urgent', 'high'] as Priority[] },
  { id: 'medium-plus', label: 'Medium+', priorities: ['urgent', 'high', 'medium'] as Priority[] },
  {
    id: 'has-priority',
    label: 'Has Priority',
    priorities: ['urgent', 'high', 'medium', 'low'] as Priority[]
  }
]

// ============================================================================
// PRIORITY DOT
// ============================================================================

const PriorityDot = ({
  color,
  className
}: {
  color: string | null
  className?: string
}): React.JSX.Element => {
  if (!color) {
    return (
      <span
        className={cn(
          'size-3 shrink-0 rounded-full border-2 border-muted-foreground/40',
          className
        )}
        aria-hidden="true"
      />
    )
  }

  return (
    <span
      className={cn('size-3 shrink-0 rounded-full', className)}
      style={{ backgroundColor: color }}
      aria-hidden="true"
    />
  )
}

// ============================================================================
// PRIORITY FILTER COMPONENT
// ============================================================================

export const PriorityFilter = ({
  selectedPriorities,
  onChange,
  taskCountByPriority = {} as Record<Priority, number>,
  className
}: PriorityFilterProps): React.JSX.Element => {
  const [isOpen, setIsOpen] = useState(false)

  const allSelected = selectedPriorities.length === 0
  const hasSelection = selectedPriorities.length > 0

  const handleToggleAll = (): void => {
    onChange([])
  }

  const handleTogglePriority = (priority: Priority): void => {
    const nextSelection = selectedPriorities.includes(priority)
      ? selectedPriorities.filter((p) => p !== priority)
      : [...selectedPriorities, priority]
    onChange(nextSelection)
  }

  const handleApplyPreset = (priorities: Priority[]): void => {
    onChange(priorities)
  }

  const handleClear = (): void => {
    onChange([])
  }

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn('h-9 gap-2', hasSelection && 'border-primary bg-primary/5', className)}
          aria-label="Filter by priority"
        >
          <span>Priority</span>
          {hasSelection && (
            <span className="bg-primary text-primary-foreground text-xs px-1.5 py-0.5 rounded-full min-w-5 text-center">
              {selectedPriorities.length}
            </span>
          )}
          <ChevronDown className="size-4 opacity-50" />
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-56 p-0" align="start">
        <div className="p-2">
          {/* Quick presets */}
          <div className="mb-2">
            <div className="text-xs font-medium text-muted-foreground px-2 py-1">QUICK SELECT</div>
            <div className="flex flex-wrap gap-1 px-2">
              {quickPresets.map((preset) => {
                const isActive =
                  selectedPriorities.length === preset.priorities.length &&
                  preset.priorities.every((p) => selectedPriorities.includes(p))

                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => handleApplyPreset(preset.priorities)}
                    className={cn(
                      'px-2 py-1 text-xs rounded-md border transition-colors',
                      isActive
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-background border-border hover:bg-accent'
                    )}
                  >
                    {preset.label}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="my-2 h-px bg-border" />

          {/* All Priorities option */}
          <button
            type="button"
            onClick={handleToggleAll}
            className={cn(
              'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors',
              'hover:bg-accent focus:outline-none focus:bg-accent',
              allSelected && 'font-medium'
            )}
          >
            <span className="flex items-center justify-center size-4">
              {allSelected && <Check className="size-4 text-primary" />}
            </span>
            <span>All Priorities</span>
          </button>

          <div className="my-2 h-px bg-border" />

          {/* Individual priorities */}
          <div className="max-h-64 overflow-y-auto">
            {priorityOptions.map((option) => {
              const isSelected = selectedPriorities.includes(option.value)
              const taskCount = taskCountByPriority[option.value] || 0

              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => handleTogglePriority(option.value)}
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
                    <PriorityDot color={option.color} />
                    <span>{option.label}</span>
                  </span>
                  <span className="text-xs text-text-tertiary">{taskCount}</span>
                </button>
              )
            })}
          </div>

          <div className="my-2 h-px bg-border" />

          {/* Action buttons */}
          <div className="flex items-center justify-end px-2 py-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleClear}
              className="h-7 text-xs text-muted-foreground hover:text-foreground"
            >
              Clear
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export default PriorityFilter
