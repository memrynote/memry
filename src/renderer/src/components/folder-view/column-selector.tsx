/**
 * Column Selector Component
 *
 * Dropdown component for adding/removing columns from the folder table view.
 * Features:
 * - Search input to filter columns
 * - Grouped sections: Built-in, Properties, Formulas
 * - Checkboxes to toggle column visibility
 * - Usage count for property columns
 */

import { useState, useMemo, useCallback } from 'react'
import { ChevronDown, Columns3, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { ColumnConfig } from '@shared/contracts/folder-view-api'

// ============================================================================
// Types
// ============================================================================

export interface AvailableProperty {
  name: string
  type: string
  usageCount: number
}

export interface BuiltInColumnInfo {
  id: string
  displayName: string
  type: string
}

interface ColumnSelectorProps {
  /** Currently visible columns */
  columns: ColumnConfig[]
  /** Built-in columns info */
  builtInColumns: BuiltInColumnInfo[]
  /** Available custom properties */
  availableProperties: AvailableProperty[]
  /** Formulas defined in folder config (future) */
  formulas?: Array<{ id: string; expression: string }>
  /** Called when columns change */
  onColumnsChange: (columns: ColumnConfig[]) => void
  /** Called when search query changes (for table highlighting) */
  onSearchChange?: (query: string) => void
  /** Additional CSS classes */
  className?: string
}

// ============================================================================
// Constants
// ============================================================================

/** Default column widths by column ID */
const DEFAULT_WIDTHS: Record<string, number> = {
  title: 250,
  folder: 120,
  tags: 150,
  created: 130,
  modified: 130,
  wordCount: 80
}

/** Default width for property columns */
const DEFAULT_PROPERTY_WIDTH = 120

// ============================================================================
// Component
// ============================================================================

/**
 * Column selector dropdown for toggling column visibility.
 */
export function ColumnSelector({
  columns,
  builtInColumns,
  availableProperties,
  formulas = [],
  onColumnsChange,
  onSearchChange,
  className
}: ColumnSelectorProps): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  // Create a set of visible column IDs for quick lookup
  const visibleColumnIds = useMemo(() => {
    return new Set(columns.map((col) => col.id))
  }, [columns])

  // Check if a column is visible
  const isColumnVisible = useCallback(
    (columnId: string) => visibleColumnIds.has(columnId),
    [visibleColumnIds]
  )

  // Filter items based on search query
  const filteredBuiltIn = useMemo(() => {
    if (!searchQuery) return builtInColumns
    const query = searchQuery.toLowerCase()
    return builtInColumns.filter((col) => col.displayName.toLowerCase().includes(query))
  }, [builtInColumns, searchQuery])

  const filteredProperties = useMemo(() => {
    if (!searchQuery) return availableProperties
    const query = searchQuery.toLowerCase()
    return availableProperties.filter((prop) => prop.name.toLowerCase().includes(query))
  }, [availableProperties, searchQuery])

  const filteredFormulas = useMemo(() => {
    if (!searchQuery) return formulas
    const query = searchQuery.toLowerCase()
    return formulas.filter((f) => f.id.toLowerCase().includes(query))
  }, [formulas, searchQuery])

  // Check if there are any search results
  const hasResults =
    filteredBuiltIn.length > 0 || filteredProperties.length > 0 || filteredFormulas.length > 0

  // Handle search input change
  const handleSearchChange = useCallback(
    (value: string) => {
      setSearchQuery(value)
      onSearchChange?.(value)
    },
    [onSearchChange]
  )

  // Handle popover open/close
  const handleOpenChange = useCallback(
    (open: boolean) => {
      setIsOpen(open)
      if (!open) {
        // Clear search and highlights when closing
        setSearchQuery('')
        onSearchChange?.('')
      }
    },
    [onSearchChange]
  )

  // Toggle column visibility
  const toggleColumn = useCallback(
    (columnId: string, checked: boolean) => {
      if (checked) {
        // Add column to end with default width
        const width = DEFAULT_WIDTHS[columnId] ?? DEFAULT_PROPERTY_WIDTH
        const newColumn: ColumnConfig = { id: columnId, width }
        onColumnsChange([...columns, newColumn])
      } else {
        // Remove column
        onColumnsChange(columns.filter((col) => col.id !== columnId))
      }
    },
    [columns, onColumnsChange]
  )

  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={cn('gap-1.5', className)}>
          <Columns3 className="h-4 w-4" />
          <span>Columns</span>
          <ChevronDown className="h-3.5 w-3.5 opacity-50" />
        </Button>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-64 p-0">
        {/* Search input */}
        <div className="p-2 border-b">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search columns..."
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="h-8 pl-8 text-sm"
            />
          </div>
        </div>

        {/* Column list */}
        <div className="max-h-80 overflow-y-auto">
          {!hasResults ? (
            <div className="p-4 text-center text-sm text-muted-foreground">No matching columns</div>
          ) : (
            <>
              {/* Built-in columns */}
              {filteredBuiltIn.length > 0 && (
                <ColumnGroup title="BUILT-IN">
                  {filteredBuiltIn.map((col) => (
                    <ColumnItem
                      key={col.id}
                      id={col.id}
                      label={col.displayName}
                      checked={isColumnVisible(col.id)}
                      onCheckedChange={(checked) => toggleColumn(col.id, checked)}
                    />
                  ))}
                </ColumnGroup>
              )}

              {/* Property columns */}
              {filteredProperties.length > 0 && (
                <ColumnGroup title="PROPERTIES">
                  {filteredProperties.map((prop) => (
                    <ColumnItem
                      key={prop.name}
                      id={prop.name}
                      label={prop.name}
                      subtitle={`${prop.usageCount} note${prop.usageCount !== 1 ? 's' : ''}`}
                      checked={isColumnVisible(prop.name)}
                      onCheckedChange={(checked) => toggleColumn(prop.name, checked)}
                    />
                  ))}
                </ColumnGroup>
              )}

              {/* Formulas (coming soon) */}
              <ColumnGroup title="FORMULAS">
                {filteredFormulas.length > 0 ? (
                  filteredFormulas.map((formula) => (
                    <ColumnItem
                      key={`formula.${formula.id}`}
                      id={`formula.${formula.id}`}
                      label={formula.id}
                      checked={isColumnVisible(`formula.${formula.id}`)}
                      onCheckedChange={(checked) => toggleColumn(`formula.${formula.id}`, checked)}
                    />
                  ))
                ) : (
                  <div className="px-3 py-2 text-xs text-muted-foreground italic">Coming soon</div>
                )}
              </ColumnGroup>
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ============================================================================
// Sub-components
// ============================================================================

/**
 * Section header for column groups
 */
function ColumnGroup({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="border-b last:border-b-0">
      <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground bg-muted/50">
        {title}
      </div>
      <div className="py-1">{children}</div>
    </div>
  )
}

/**
 * Individual column item with checkbox
 */
function ColumnItem({
  id,
  label,
  subtitle,
  checked,
  onCheckedChange
}: {
  id: string
  label: string
  subtitle?: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}): React.JSX.Element {
  return (
    <label
      htmlFor={`col-${id}`}
      className={cn(
        'flex items-center gap-2 px-3 py-1.5 cursor-pointer',
        'hover:bg-muted/50 transition-colors'
      )}
    >
      <Checkbox
        id={`col-${id}`}
        checked={checked}
        onCheckedChange={(checked) => onCheckedChange(checked === true)}
      />
      <div className="flex-1 min-w-0">
        <span className="text-sm truncate block" title={label}>
          {label}
        </span>
        {subtitle && (
          <span className="text-xs text-muted-foreground truncate block">{subtitle}</span>
        )}
      </div>
    </label>
  )
}

export default ColumnSelector
