import { ChevronDown, Star, Settings, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import type { SavedFilter } from '@/data/tasks-data'

// ============================================================================
// TYPES
// ============================================================================

interface SavedFiltersDropdownProps {
  savedFilters: SavedFilter[]
  onApply: (filter: SavedFilter) => void
  onDelete: (filterId: string) => void
  onManage?: () => void
  className?: string
}

// ============================================================================
// SAVED FILTERS DROPDOWN COMPONENT
// ============================================================================

export const SavedFiltersDropdown = ({
  savedFilters,
  onApply,
  onDelete,
  onManage,
  className
}: SavedFiltersDropdownProps): React.JSX.Element => {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
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
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-56">
        {savedFilters.length > 0 ? (
          <>
            {savedFilters.map((filter) => (
              <div key={filter.id} className="flex items-center justify-between group">
                <DropdownMenuItem onClick={() => onApply(filter)} className="flex-1 cursor-pointer">
                  <Star className="size-4 mr-2 text-amber-500" />
                  <span className="truncate">{filter.name}</span>
                </DropdownMenuItem>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onDelete(filter.id)
                  }}
                  className={cn(
                    'p-1.5 mr-2 rounded text-muted-foreground',
                    'opacity-0 group-hover:opacity-100 transition-opacity',
                    'hover:text-destructive hover:bg-destructive/10',
                    'focus:outline-none focus:opacity-100'
                  )}
                  aria-label={`Delete ${filter.name}`}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))}
            <DropdownMenuSeparator />
          </>
        ) : (
          <div className="px-3 py-2 text-sm text-muted-foreground">No saved filters yet</div>
        )}

        {onManage && (
          <DropdownMenuItem onClick={onManage}>
            <Settings className="size-4 mr-2" />
            Manage saved filters...
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export default SavedFiltersDropdown
