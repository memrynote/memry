import { useState } from 'react'
import { ChevronDown } from 'lucide-react'

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

// ============================================================================
// PRIORITY OPTIONS — Paper design colors
// ============================================================================

const PRIORITY_DISPLAY: Record<
  Priority,
  { label: string; dot: string; checkBorder: string; checkBg: string; checkStroke: string }
> = {
  urgent: {
    label: 'Urgent',
    dot: '#E54D2E',
    checkBorder: '#E54D2E',
    checkBg: '#FEF0EE',
    checkStroke: '#E54D2E'
  },
  high: {
    label: 'High',
    dot: '#F59E0B',
    checkBorder: '#F59E0B',
    checkBg: '#FFF8EB',
    checkStroke: '#F59E0B'
  },
  medium: {
    label: 'Medium',
    dot: '#22C55E',
    checkBorder: '#D4D1CA',
    checkBg: '#FFFFFF',
    checkStroke: '#22C55E'
  },
  low: {
    label: 'Low',
    dot: '#3B82F6',
    checkBorder: '#D4D1CA',
    checkBg: '#FFFFFF',
    checkStroke: '#3B82F6'
  },
  none: {
    label: 'None',
    dot: '#D4D1CA',
    checkBorder: '#D4D1CA',
    checkBg: '#FFFFFF',
    checkStroke: '#D4D1CA'
  }
}

const PRIORITY_ORDER: Priority[] = ['urgent', 'high', 'medium', 'low', 'none']

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

  const hasSelection = selectedPriorities.length > 0

  const handleTogglePriority = (priority: Priority): void => {
    const nextSelection = selectedPriorities.includes(priority)
      ? selectedPriorities.filter((p) => p !== priority)
      : [...selectedPriorities, priority]
    onChange(nextSelection)
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

      <PopoverContent
        className="w-60 p-0 rounded-sm overflow-clip shadow-[0_4px_24px_rgba(0,0,0,0.08),0_1px_3px_rgba(0,0,0,0.04)]"
        align="start"
      >
        {/* Options list */}
        <div className="flex flex-col py-2">
          {PRIORITY_ORDER.map((priority) => {
            const display = PRIORITY_DISPLAY[priority]
            const isSelected = selectedPriorities.includes(priority)
            const taskCount = taskCountByPriority[priority] || 0

            return (
              <button
                key={priority}
                type="button"
                onClick={() => handleTogglePriority(priority)}
                className={cn(
                  'flex items-center gap-2.5 py-2 px-4 transition-colors',
                  'hover:bg-[#F9F8F6] focus:outline-none focus:bg-[#F9F8F6]'
                )}
              >
                {/* Checkbox */}
                <div
                  className="flex items-center justify-center rounded-sm shrink-0 size-4"
                  style={{
                    borderWidth: '1.5px',
                    borderStyle: 'solid',
                    borderColor: isSelected ? display.checkBorder : '#D4D1CA',
                    backgroundColor: isSelected ? display.checkBg : '#FFFFFF'
                  }}
                >
                  {isSelected && (
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke={display.checkStroke}
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </div>
                {/* Color dot */}
                <div
                  className="shrink-0 rounded-full size-2"
                  style={{ backgroundColor: display.dot }}
                />
                {/* Label */}
                <span
                  className={cn(
                    "text-[13px] font-['DM_Sans',system-ui,sans-serif] leading-4",
                    isSelected ? 'font-medium text-[#1A1A1A]' : 'text-[#1A1A1A]',
                    priority === 'none' && !isSelected && 'text-[#6A6A6A]'
                  )}
                >
                  {display.label}
                </span>
                {/* Count */}
                <span className="text-[11px] ml-auto text-[#8A8A8A] font-['DM_Sans',system-ui,sans-serif] leading-[14px]">
                  {taskCount}
                </span>
              </button>
            )
          })}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between py-2.5 px-4 bg-[#FAFAF8] border-t border-[#E8E5E0]">
          <button
            type="button"
            onClick={handleClear}
            className="text-[12px] text-[#8A8A8A] font-['DM_Sans',system-ui,sans-serif] font-medium leading-4 hover:text-[#1A1A1A] transition-colors"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={() => setIsOpen(false)}
            className="flex items-center rounded-sm py-[5px] px-3.5 gap-1 bg-[#1A1A1A] hover:bg-[#333] transition-colors"
          >
            <span className="text-[12px] text-white font-['DM_Sans',system-ui,sans-serif] font-semibold leading-4">
              Apply
            </span>
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export default PriorityFilter
