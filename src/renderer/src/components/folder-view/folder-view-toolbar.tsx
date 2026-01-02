/**
 * Folder View Toolbar Component
 *
 * Toolbar containing column selector, filter, and search controls.
 * Positioned between the header and the table.
 */

import { Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  ColumnSelector,
  type AvailableProperty,
  type BuiltInColumnInfo,
  type FormulaInfo
} from './column-selector'
import { FilterBuilder } from './filter-builder'
import type {
  ColumnConfig,
  FilterExpression,
  NoteWithProperties,
  SummaryConfig
} from '@shared/contracts/folder-view-api'

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
  /** Formulas defined in folder config */
  formulas?: FormulaInfo[]
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
  /** Called when a formula is added */
  onFormulaAdd?: (name: string, expression: string) => Promise<void>
  /** Called when a formula is updated */
  onFormulaEdit?: (name: string, expression: string) => Promise<void>
  /** Called when a formula is deleted */
  onFormulaDelete?: (name: string) => Promise<void>
  /** Sample note for formula preview */
  sampleNote?: NoteWithProperties | null
  /** Summary configurations per column - Phase 23 */
  summaries?: Record<string, SummaryConfig>
  /** Called when summary config changes for a column - Phase 23 */
  onSummaryChange?: (columnId: string, config: SummaryConfig | undefined) => void
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
  onFormulaAdd,
  onFormulaEdit,
  onFormulaDelete,
  sampleNote,
  summaries,
  onSummaryChange,
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
        onFormulaAdd={onFormulaAdd}
        onFormulaEdit={onFormulaEdit}
        onFormulaDelete={onFormulaDelete}
        sampleNote={sampleNote}
        summaries={summaries}
        onSummaryChange={onSummaryChange}
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

      {/* Global Search Input - responsive width with min/max constraints */}
      <div className="relative w-48 min-w-32 max-w-64 flex-shrink">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
        <Input
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search notes..."
          className="h-8 pl-8 pr-8 text-sm w-full"
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
