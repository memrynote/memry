/**
 * Folder View Toolbar Component
 *
 * Toolbar containing column selector, filter, and search controls.
 * Positioned between the header and the table.
 */

import { Search } from 'lucide-react'
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

      {/* Search Input (placeholder for Phase 15) */}
      <div className="relative w-64">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input placeholder="Search notes..." className="h-8 pl-8 text-sm" disabled />
      </div>
    </div>
  )
}

export default FolderViewToolbar
