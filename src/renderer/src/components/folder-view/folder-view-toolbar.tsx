/**
 * Folder View Toolbar Component
 *
 * Toolbar containing column selector, filter, and search controls.
 * Positioned between the header and the table.
 */

import { Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { ColumnSelector, type AvailableProperty, type BuiltInColumnInfo } from './column-selector'
import { FilterBuilder } from './filter-builder'
import type { ColumnConfig, FilterExpression } from '@shared/contracts/folder-view-api'

// ============================================================================
// Types
// ============================================================================

interface FolderViewToolbarProps {
  /** Currently visible columns */
  columns: ColumnConfig[]
  /** Built-in columns info */
  builtInColumns: BuiltInColumnInfo[]
  /** Available custom properties */
  availableProperties: AvailableProperty[]
  /** Formulas defined in folder config (future) */
  formulas?: Array<{ id: string; expression: string }>
  /** Current filter expression */
  filters?: FilterExpression
  /** Current global search query */
  searchQuery: string
  /** Called when global search query changes */
  onSearchChange: (query: string) => void
  /** Called when columns change */
  onColumnsChange: (columns: ColumnConfig[]) => void
  /** Called when filters change */
  onFiltersChange: (filters: FilterExpression | undefined) => void
  /** Called when column search changes (for table highlighting) */
  onColumnSearchChange?: (query: string) => void
  /** Additional CSS classes */
  className?: string
}

// ============================================================================
// Component
// ============================================================================

/**
 * Toolbar for folder view with column selector, filter, and search.
 */
export function FolderViewToolbar({
  columns,
  builtInColumns,
  availableProperties,
  formulas,
  filters,
  searchQuery,
  onSearchChange,
  onColumnsChange,
  onFiltersChange,
  onColumnSearchChange,
  className
}: FolderViewToolbarProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex items-center gap-2 px-4 py-2 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60',
        className
      )}
    >
      {/* Column Selector */}
      <ColumnSelector
        columns={columns}
        builtInColumns={builtInColumns}
        availableProperties={availableProperties}
        formulas={formulas}
        onColumnsChange={onColumnsChange}
        onSearchChange={onColumnSearchChange}
      />

      {/* Filter Builder */}
      <FilterBuilder
        filters={filters}
        availableProperties={availableProperties}
        builtInColumns={builtInColumns}
        onFiltersChange={onFiltersChange}
      />

      {/* Spacer */}
      <div className="flex-1" />

      {/* Global Search Input */}
      <div className="relative w-64">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
        <Input
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search notes..."
          className="h-8 pl-8 pr-8 text-sm"
        />
        {searchQuery && (
          <button
            type="button"
            onClick={() => onSearchChange('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Clear search"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  )
}

export default FolderViewToolbar
