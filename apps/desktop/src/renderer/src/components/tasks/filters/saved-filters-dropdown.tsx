import { Star, Plus, X, ChevronDown } from '@/lib/icons'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { SavedFilter } from '@/data/tasks-data'

// ============================================================================
// TYPES
// ============================================================================

interface SavedFiltersDropdownProps {
  savedFilters: SavedFilter[]
  onApply: (filter: SavedFilter) => void
  onDelete: (filterId: string) => void
  onSaveCurrent?: () => void
  className?: string
}

// ============================================================================
// SAVED FILTERS DROPDOWN COMPONENT
// ============================================================================

export const SavedFiltersDropdown = ({
  savedFilters,
  onApply,
  onDelete,
  onSaveCurrent,
  className
}: SavedFiltersDropdownProps): React.JSX.Element => {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn('h-9 gap-2', className)}
          aria-label="Saved filters"
        >
          <Star className="size-4" />
          <span className="hidden sm:inline">Saved</span>
          <ChevronDown className="size-4 opacity-50" />
        </Button>
      </PopoverTrigger>

      <PopoverContent
        className="w-[280px] p-0 rounded-sm overflow-clip shadow-dropdown"
        align="end"
      >
        {/* Saved presets */}
        <div className="flex flex-col py-2">
          {savedFilters.length > 0 ? (
            savedFilters.map((filter, index) => (
              <div
                key={filter.id}
                className="flex items-center py-[9px] px-4 gap-2.5 group hover:bg-surface transition-colors"
              >
                <button
                  type="button"
                  onClick={() => onApply(filter)}
                  className="flex items-center gap-2.5 flex-1 min-w-0 focus:outline-none"
                >
                  <Star
                    className={cn(
                      'size-3.5 shrink-0',
                      index === 0 ? 'fill-task-star text-task-star' : 'text-text-tertiary'
                    )}
                  />
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span
                      className={cn(
                        'text-[13px] leading-4 truncate',
                        index === 0 ? 'font-medium text-foreground' : 'text-foreground'
                      )}
                    >
                      {filter.name}
                    </span>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onDelete(filter.id)
                  }}
                  className="p-1 rounded text-text-tertiary opacity-0 group-hover:opacity-100 hover:text-destructive hover:bg-destructive/5 transition-all focus:outline-none focus:opacity-100 shrink-0"
                  aria-label={`Delete ${filter.name}`}
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ))
          ) : (
            <div className="px-4 py-3 text-[13px] text-text-tertiary">No saved filters yet</div>
          )}
        </div>

        {/* Save current footer */}
        <div className="border-t border-border">
          {onSaveCurrent ? (
            <button
              type="button"
              onClick={onSaveCurrent}
              className="flex items-center w-full py-2.5 px-4 gap-2 hover:bg-accent transition-colors focus:outline-none"
            >
              <Plus className="size-3.5 text-text-tertiary" />
              <span className="text-[13px] text-text-tertiary font-medium leading-4">
                Save current filters
              </span>
            </button>
          ) : (
            <div className="flex items-center py-2.5 px-4 gap-2 opacity-50">
              <Plus className="size-3.5 text-text-tertiary" />
              <span className="text-[13px] text-text-tertiary font-medium leading-4">
                Save current filters
              </span>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export default SavedFiltersDropdown
