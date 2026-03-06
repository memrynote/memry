/**
 * Group By Selector Component
 *
 * Dropdown for selecting a property to group table rows by.
 * Supports built-in columns and custom properties.
 *
 * Phase 24: T112 - Add groupBy selector to toolbar
 */

import { useState, useMemo, useCallback } from 'react'
import { Layers, X, Check, ArrowUpAZ, ArrowDownZA } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import type { GroupByConfig } from '@memry/contracts/folder-view-api'

// ============================================================================
// Types
// ============================================================================

interface GroupBySelectorProps {
  /** Current group by configuration */
  groupBy?: GroupByConfig
  /** Available custom properties */
  availableProperties: Array<{ name: string; type: string; usageCount: number }>
  /** Built-in column info */
  builtInColumns: Array<{ id: string; displayName: string; type: string }>
  /** Called when groupBy changes */
  onGroupByChange: (groupBy: GroupByConfig | undefined) => void
  /** Additional CSS classes */
  className?: string
}

// ============================================================================
// Constants
// ============================================================================

/** Properties that work well for grouping */
const GROUPABLE_BUILT_IN = ['folder', 'tags', 'created', 'modified'] as const

/** Property types that support grouping */
const GROUPABLE_TYPES = new Set(['text', 'select', 'multiselect', 'checkbox', 'date', 'number'])

// ============================================================================
// Component
// ============================================================================

/**
 * Dropdown selector for grouping table rows by a property.
 */
export function GroupBySelector({
  groupBy,
  availableProperties,
  builtInColumns,
  onGroupByChange,
  className
}: GroupBySelectorProps): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  // Filter built-in columns to only include groupable ones
  const groupableBuiltIn = useMemo(() => {
    return builtInColumns.filter((col) =>
      GROUPABLE_BUILT_IN.includes(col.id as (typeof GROUPABLE_BUILT_IN)[number])
    )
  }, [builtInColumns])

  // Filter custom properties to only include groupable types
  const groupableProperties = useMemo(() => {
    return availableProperties.filter((prop) => GROUPABLE_TYPES.has(prop.type))
  }, [availableProperties])

  // Filter by search query
  const filteredBuiltIn = useMemo(() => {
    if (!searchQuery) return groupableBuiltIn
    const query = searchQuery.toLowerCase()
    return groupableBuiltIn.filter(
      (col) => col.id.toLowerCase().includes(query) || col.displayName.toLowerCase().includes(query)
    )
  }, [groupableBuiltIn, searchQuery])

  const filteredProperties = useMemo(() => {
    if (!searchQuery) return groupableProperties
    const query = searchQuery.toLowerCase()
    return groupableProperties.filter((prop) => prop.name.toLowerCase().includes(query))
  }, [groupableProperties, searchQuery])

  // Get display name for current groupBy property
  const currentPropertyName = useMemo(() => {
    if (!groupBy?.property) return null

    // Check built-in columns
    const builtIn = builtInColumns.find((col) => col.id === groupBy.property)
    if (builtIn) return builtIn.displayName

    // Check custom properties
    const custom = availableProperties.find((prop) => prop.name === groupBy.property)
    if (custom) return capitalizeFirst(custom.name)

    return capitalizeFirst(groupBy.property)
  }, [groupBy?.property, builtInColumns, availableProperties])

  // Handle property selection
  const handleSelectProperty = useCallback(
    (propertyId: string) => {
      if (groupBy?.property === propertyId) {
        // Already selected - do nothing (use clear button to remove)
        return
      }

      onGroupByChange({
        property: propertyId,
        direction: 'asc',
        collapsed: false,
        showSummary: false
      })
    },
    [groupBy?.property, onGroupByChange]
  )

  // Handle direction toggle
  const handleDirectionChange = useCallback(() => {
    if (!groupBy) return

    onGroupByChange({
      ...groupBy,
      direction: groupBy.direction === 'asc' ? 'desc' : 'asc'
    })
  }, [groupBy, onGroupByChange])

  // Handle collapsed toggle
  const handleCollapsedChange = useCallback(
    (collapsed: boolean) => {
      if (!groupBy) return

      onGroupByChange({
        ...groupBy,
        collapsed
      })
    },
    [groupBy, onGroupByChange]
  )

  // Handle show summary toggle
  const handleShowSummaryChange = useCallback(
    (showSummary: boolean) => {
      if (!groupBy) return

      onGroupByChange({
        ...groupBy,
        showSummary
      })
    },
    [groupBy, onGroupByChange]
  )

  // Handle clear grouping
  const handleClearGrouping = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onGroupByChange(undefined)
    },
    [onGroupByChange]
  )

  const isGrouped = !!groupBy?.property

  return (
    <TooltipProvider>
      <Popover open={isOpen} onOpenChange={setIsOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  'gap-1.5 px-2',
                  isGrouped && 'bg-primary/10 border-primary/30',
                  className
                )}
              >
                <Layers className="h-4 w-4" />
                {isGrouped && (
                  <button
                    type="button"
                    onClick={handleClearGrouping}
                    className="ml-1 p-0.5 rounded hover:bg-muted"
                    aria-label="Clear grouping"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {isGrouped ? `Group by ${currentPropertyName}` : 'Group'}
          </TooltipContent>
        </Tooltip>

        <PopoverContent align="start" className="w-72 p-0">
          {/* Search */}
          <div className="p-2 border-b">
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search properties..."
              className="h-8"
            />
          </div>

          {/* Property List */}
          <div className="max-h-64 overflow-y-auto p-1">
            {/* Built-in columns */}
            {filteredBuiltIn.length > 0 && (
              <div className="mb-2">
                <div className="px-2 py-1 text-xs font-medium text-muted-foreground uppercase">
                  Built-in
                </div>
                {filteredBuiltIn.map((col) => (
                  <PropertyRow
                    key={col.id}
                    name={col.displayName}
                    type={col.type}
                    isSelected={groupBy?.property === col.id}
                    onClick={() => handleSelectProperty(col.id)}
                  />
                ))}
              </div>
            )}

            {/* Custom properties */}
            {filteredProperties.length > 0 && (
              <div>
                {filteredBuiltIn.length > 0 && <Separator className="my-1" />}
                <div className="px-2 py-1 text-xs font-medium text-muted-foreground uppercase">
                  Properties
                </div>
                {filteredProperties.map((prop) => (
                  <PropertyRow
                    key={prop.name}
                    name={capitalizeFirst(prop.name)}
                    type={prop.type}
                    usageCount={prop.usageCount}
                    isSelected={groupBy?.property === prop.name}
                    onClick={() => handleSelectProperty(prop.name)}
                  />
                ))}
              </div>
            )}

            {/* No results */}
            {filteredBuiltIn.length === 0 && filteredProperties.length === 0 && (
              <div className="px-2 py-4 text-center text-sm text-muted-foreground">
                No groupable properties found
              </div>
            )}
          </div>

          {/* Options (when grouped) */}
          {isGrouped && (
            <>
              <Separator />
              <div className="p-2 space-y-3">
                {/* Direction toggle */}
                <div className="flex items-center justify-between">
                  <Label className="text-sm">Sort direction</Label>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleDirectionChange}
                    className="h-7 gap-1.5"
                  >
                    {groupBy?.direction === 'asc' ? (
                      <>
                        <ArrowUpAZ className="h-4 w-4" />
                        <span className="text-xs">A → Z</span>
                      </>
                    ) : (
                      <>
                        <ArrowDownZA className="h-4 w-4" />
                        <span className="text-xs">Z → A</span>
                      </>
                    )}
                  </Button>
                </div>

                {/* Collapsed by default */}
                <div className="flex items-center justify-between">
                  <Label htmlFor="collapsed-toggle" className="text-sm">
                    Collapse groups by default
                  </Label>
                  <Switch
                    id="collapsed-toggle"
                    checked={groupBy?.collapsed ?? false}
                    onCheckedChange={handleCollapsedChange}
                  />
                </div>

                {/* Show summaries */}
                <div className="flex items-center justify-between">
                  <Label htmlFor="summary-toggle" className="text-sm">
                    Show group summaries
                  </Label>
                  <Switch
                    id="summary-toggle"
                    checked={groupBy?.showSummary ?? false}
                    onCheckedChange={handleShowSummaryChange}
                  />
                </div>
              </div>
            </>
          )}

          {/* Clear grouping button */}
          {isGrouped && (
            <>
              <Separator />
              <div className="p-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    onGroupByChange(undefined)
                    setIsOpen(false)
                  }}
                  className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                  Clear grouping
                </Button>
              </div>
            </>
          )}
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  )
}

// ============================================================================
// Sub-components
// ============================================================================

interface PropertyRowProps {
  name: string
  type: string
  usageCount?: number
  isSelected: boolean
  onClick: () => void
}

function PropertyRow({
  name,
  type,
  usageCount,
  isSelected,
  onClick
}: PropertyRowProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm text-left',
        'hover:bg-muted transition-colors',
        isSelected && 'bg-primary/10'
      )}
    >
      <div
        className={cn(
          'w-4 h-4 flex items-center justify-center flex-shrink-0',
          isSelected ? 'text-primary' : 'text-transparent'
        )}
      >
        {isSelected && <Check className="h-4 w-4" />}
      </div>

      <span className="flex-1 truncate">{name}</span>

      {usageCount !== undefined && (
        <Badge variant="secondary" className="text-xs px-1.5 py-0">
          {usageCount}
        </Badge>
      )}

      <span className="text-xs text-muted-foreground capitalize">{type}</span>
    </button>
  )
}

// ============================================================================
// Utilities
// ============================================================================

function capitalizeFirst(str: string): string {
  if (!str) return str
  const spaced = str.replace(/([A-Z])/g, ' $1').trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

export default GroupBySelector
