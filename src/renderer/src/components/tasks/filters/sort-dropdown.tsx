import { useState } from 'react'
import { ChevronDown, ArrowUp, ArrowDown } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { TaskSort, SortField, SortDirection } from '@/data/tasks-data'
import { sortFieldOptions } from '@/data/tasks-data'

// ============================================================================
// TYPES
// ============================================================================

interface SortDropdownProps {
  sort: TaskSort
  onChange: (sort: TaskSort) => void
  className?: string
}

// ============================================================================
// SORT DROPDOWN COMPONENT
// ============================================================================

export const SortDropdown = ({
  sort,
  onChange,
  className
}: SortDropdownProps): React.JSX.Element => {
  const [isOpen, setIsOpen] = useState(false)

  const currentOption = sortFieldOptions.find((o) => o.value === sort.field)
  const directionIcon = sort.direction === 'asc' ? '↑' : '↓'

  const handleSelectField = (field: SortField): void => {
    onChange({ ...sort, field })
  }

  const handleToggleDirection = (direction: SortDirection): void => {
    onChange({ ...sort, direction })
  }

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn('h-9 gap-2', className)}
          aria-label="Sort options"
        >
          <span>
            Sort: {currentOption?.label} {directionIcon}
          </span>
          <ChevronDown className="size-4 opacity-50" />
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-56 p-0" align="end">
        <div className="p-2">
          <div className="text-xs font-medium text-muted-foreground px-2 py-1.5 uppercase">
            Sort by
          </div>

          {sortFieldOptions.map((option) => {
            const isSelected = sort.field === option.value

            return (
              <div
                key={option.value}
                className={cn(
                  'flex items-center justify-between rounded-sm px-2 py-1.5 transition-colors',
                  'hover:bg-accent',
                  isSelected && 'bg-accent'
                )}
              >
                <button
                  type="button"
                  onClick={() => handleSelectField(option.value)}
                  className={cn(
                    'flex-1 text-left text-sm focus:outline-none',
                    isSelected && 'font-medium'
                  )}
                >
                  {option.label}
                </button>

                {isSelected && (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => handleToggleDirection('asc')}
                      className={cn(
                        'p-1 rounded text-xs transition-colors focus:outline-none',
                        sort.direction === 'asc'
                          ? 'bg-primary text-primary-foreground'
                          : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                      )}
                      aria-label="Sort ascending"
                      title="Ascending"
                    >
                      <ArrowUp className="size-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleToggleDirection('desc')}
                      className={cn(
                        'p-1 rounded text-xs transition-colors focus:outline-none',
                        sort.direction === 'desc'
                          ? 'bg-primary text-primary-foreground'
                          : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                      )}
                      aria-label="Sort descending"
                      title="Descending"
                    >
                      <ArrowDown className="size-3" />
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export default SortDropdown
