import { useState, useEffect, useCallback, useRef } from 'react'
import { Check, ChevronDown } from '@/lib/icons'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { priorityConfig, type Priority } from '@/data/sample-tasks'

// ============================================================================
// TYPES
// ============================================================================

interface PrioritySelectProps {
  value: Priority
  onChange: (value: Priority) => void
  className?: string
  compact?: boolean
}

// ============================================================================
// PRIORITY OPTIONS
// ============================================================================

interface PriorityOption {
  value: Priority
  label: string
  shortLabel: string
  color: string | null
  shortcut: string
}

const priorityOptions: PriorityOption[] = [
  { value: 'none', label: 'No priority', shortLabel: 'None', color: null, shortcut: '1' },
  {
    value: 'low',
    label: 'Low priority',
    shortLabel: 'Low',
    color: priorityConfig.low.color,
    shortcut: '2'
  },
  {
    value: 'medium',
    label: 'Medium priority',
    shortLabel: 'Medium',
    color: priorityConfig.medium.color,
    shortcut: '3'
  },
  {
    value: 'high',
    label: 'High priority',
    shortLabel: 'High',
    color: priorityConfig.high.color,
    shortcut: '4'
  },
  {
    value: 'urgent',
    label: 'Urgent',
    shortLabel: 'Urgent',
    color: priorityConfig.urgent.color,
    shortcut: '5'
  }
]

// ============================================================================
// PRIORITY DOT COMPONENT
// ============================================================================

const PriorityDot = ({
  color,
  className,
  compact = false
}: {
  color: string | null
  className?: string
  compact?: boolean
}): React.JSX.Element => {
  if (!color) {
    // Empty circle for "none"
    return (
      <span
        className={cn(
          'shrink-0 rounded-full border-2 border-muted-foreground/40',
          compact ? 'size-2' : 'size-3',
          className
        )}
        aria-hidden="true"
      />
    )
  }

  return (
    <span
      className={cn('shrink-0 rounded-full', compact ? 'size-2' : 'size-3', className)}
      style={{ backgroundColor: color }}
      aria-hidden="true"
    />
  )
}

// ============================================================================
// PRIORITY SELECT COMPONENT
// ============================================================================

export const PrioritySelect = ({
  value,
  onChange,
  className,
  compact = false
}: PrioritySelectProps): React.JSX.Element => {
  const [isOpen, setIsOpen] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(-1)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const currentOption = priorityOptions.find((opt) => opt.value === value)
  const currentIndex = priorityOptions.findIndex((opt) => opt.value === value)

  // Reset highlighted index when popover opens
  useEffect(() => {
    if (isOpen) {
      setHighlightedIndex(currentIndex)
    } else {
      setHighlightedIndex(-1)
    }
  }, [isOpen, currentIndex])

  // Handle keyboard shortcuts
  const handleKeyDown = useCallback(
    (e: KeyboardEvent): void => {
      if (!isOpen) return

      const key = e.key

      // Number shortcuts 1-5
      if (key >= '1' && key <= '5') {
        e.preventDefault()
        const index = parseInt(key, 10) - 1
        if (index >= 0 && index < priorityOptions.length) {
          onChange(priorityOptions[index].value)
          setIsOpen(false)
        }
        return
      }

      // Arrow navigation
      if (key === 'ArrowDown') {
        e.preventDefault()
        setHighlightedIndex((prev) => (prev < priorityOptions.length - 1 ? prev + 1 : 0))
      } else if (key === 'ArrowUp') {
        e.preventDefault()
        setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : priorityOptions.length - 1))
      } else if (key === 'Enter') {
        e.preventDefault()
        if (highlightedIndex >= 0 && highlightedIndex < priorityOptions.length) {
          onChange(priorityOptions[highlightedIndex].value)
          setIsOpen(false)
        }
      } else if (key === 'Escape') {
        e.preventDefault()
        setIsOpen(false)
      }
    },
    [isOpen, highlightedIndex, onChange]
  )

  // Add keyboard listener when popover is open
  useEffect(() => {
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown)
    } else {
      document.removeEventListener('keydown', handleKeyDown)
    }

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, handleKeyDown])

  // Scroll highlighted item into view
  useEffect(() => {
    if (isOpen && highlightedIndex >= 0 && listRef.current) {
      const highlightedElement = listRef.current.children[highlightedIndex] as HTMLElement
      if (highlightedElement) {
        highlightedElement.scrollIntoView({ block: 'nearest' })
      }
    }
  }, [isOpen, highlightedIndex])

  const handleSelect = useCallback(
    (priority: Priority): void => {
      onChange(priority)
      setIsOpen(false)
    },
    [onChange]
  )

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          ref={triggerRef}
          variant="outline"
          role="combobox"
          aria-expanded={isOpen}
          aria-label="Select priority"
          className={cn('w-full justify-between', compact && 'h-9 text-sm', className)}
        >
          <div className="flex items-center gap-2">
            <PriorityDot color={currentOption?.color || null} compact={compact} />
            <span className={cn(compact && 'text-sm')}>{currentOption?.shortLabel || 'None'}</span>
          </div>
          <ChevronDown className={cn('ml-2 shrink-0 opacity-50', compact ? 'size-3' : 'size-4')} />
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-[200px] p-1" align="start">
        <div ref={listRef} role="listbox" aria-label="Priority options">
          {priorityOptions.map((option, index) => {
            const isSelected = option.value === value
            const isHighlighted = index === highlightedIndex

            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => handleSelect(option.value)}
                onMouseEnter={() => setHighlightedIndex(index)}
                className={cn(
                  'flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm transition-colors',
                  'focus:outline-none',
                  isHighlighted && 'bg-accent',
                  isSelected && 'font-medium'
                )}
              >
                <span className="flex items-center gap-2">
                  <PriorityDot color={option.color} />
                  <span>{option.label}</span>
                </span>
                <span className="flex items-center gap-2">
                  {isSelected && <Check className="size-4 text-primary" />}
                  <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-muted px-1 text-[10px] font-medium text-muted-foreground">
                    {option.shortcut}
                  </kbd>
                </span>
              </button>
            )
          })}
        </div>

        {/* Keyboard hint */}
        <div className="mt-1 border-t border-border pt-1.5 px-2 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <kbd className="inline-flex h-4 items-center justify-center rounded border border-border bg-muted px-0.5 text-[10px]">
              ↑
            </kbd>
            <kbd className="inline-flex h-4 items-center justify-center rounded border border-border bg-muted px-0.5 text-[10px]">
              ↓
            </kbd>
            <span className="ml-1">navigate</span>
            <kbd className="ml-2 inline-flex h-4 items-center justify-center rounded border border-border bg-muted px-1 text-[10px]">
              ↵
            </kbd>
            <span className="ml-1">select</span>
          </span>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export default PrioritySelect
