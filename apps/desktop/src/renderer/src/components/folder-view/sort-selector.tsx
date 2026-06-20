/**
 * Sort Selector Component
 *
 * Dropdown for choosing a property to sort the view by. Unlike the table's
 * column-header sorting, this works across all view types (table/list/gallery)
 * by editing the persisted view.order.
 *
 * ponytail: single-key sort (order[0]); multi-sort stays available via table headers.
 */

import { useState, useMemo, useCallback } from 'react'
import { ArrowUpDown, X, Check, Search, ArrowUpAZ, ArrowDownZA } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Label } from '@/components/ui/label'
import { getColumnIcon } from './column-icons'
import { type AppIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { OrderConfig } from '@memry/contracts/folder-view-api'
import { useT } from '@memry/i18n/renderer'

// ============================================================================
// Types
// ============================================================================

interface SortSelectorProps {
  /** Current sort order (multi-column); this selector edits the primary key */
  order?: OrderConfig[]
  /** Available custom properties */
  availableProperties: Array<{ name: string; type: string; usageCount: number }>
  /** Built-in column info */
  builtInColumns: Array<{ id: string; displayName: string; type: string }>
  /** Called when sort order changes */
  onSortingChange: (order: OrderConfig[]) => void
  /** Additional CSS classes */
  className?: string
}

/** Built-in columns that make sense to sort by */
const SORTABLE_BUILT_IN = ['title', 'created', 'modified', 'folder', 'tags', 'wordCount'] as const

// ============================================================================
// Component
// ============================================================================

export function SortSelector({
  order,
  availableProperties,
  builtInColumns,
  onSortingChange,
  className
}: SortSelectorProps): React.JSX.Element {
  const { t: tPhaseF } = useT('notes')
  const [isOpen, setIsOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  const primary = order?.[0]

  const sortableBuiltIn = useMemo(
    () =>
      builtInColumns.filter((col) =>
        SORTABLE_BUILT_IN.includes(col.id as (typeof SORTABLE_BUILT_IN)[number])
      ),
    [builtInColumns]
  )

  const filteredBuiltIn = useMemo(() => {
    if (!searchQuery) return sortableBuiltIn
    const query = searchQuery.toLowerCase()
    return sortableBuiltIn.filter(
      (col) => col.id.toLowerCase().includes(query) || col.displayName.toLowerCase().includes(query)
    )
  }, [sortableBuiltIn, searchQuery])

  const filteredProperties = useMemo(() => {
    if (!searchQuery) return availableProperties
    const query = searchQuery.toLowerCase()
    return availableProperties.filter((prop) => prop.name.toLowerCase().includes(query))
  }, [availableProperties, searchQuery])

  const currentPropertyName = useMemo(() => {
    if (!primary?.property) return null
    const builtIn = builtInColumns.find((col) => col.id === primary.property)
    if (builtIn) return builtIn.displayName
    const custom = availableProperties.find((prop) => prop.name === primary.property)
    if (custom) return capitalizeFirst(custom.name)
    return capitalizeFirst(primary.property)
  }, [primary, builtInColumns, availableProperties])

  // Select a property: same property toggles direction, new property starts asc.
  const handleSelectProperty = useCallback(
    (propertyId: string) => {
      if (primary?.property === propertyId) {
        onSortingChange([
          { property: propertyId, direction: primary.direction === 'asc' ? 'desc' : 'asc' }
        ])
        return
      }
      onSortingChange([{ property: propertyId, direction: 'asc' }])
    },
    [primary, onSortingChange]
  )

  const handleDirectionChange = useCallback(() => {
    if (!primary) return
    onSortingChange([
      { property: primary.property, direction: primary.direction === 'asc' ? 'desc' : 'asc' }
    ])
  }, [primary, onSortingChange])

  const handleClear = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onSortingChange([])
    },
    [onSortingChange]
  )

  const isSorted = !!primary?.property

  return (
    <TooltipProvider delayDuration={0}>
      <Popover open={isOpen} onOpenChange={setIsOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  'h-auto gap-1 rounded-[5px] border border-border px-2 py-1 text-muted-foreground hover:bg-surface-active/50 hover:text-foreground',
                  isSorted &&
                    'border-foreground/20 bg-foreground/5 text-foreground/90 hover:bg-foreground/5 hover:text-foreground/90',
                  className
                )}
              >
                <ArrowUpDown className="size-3" />
                {isSorted && (
                  <button
                    type="button"
                    onClick={handleClear}
                    className="ms-1 rounded p-0.5 hover:bg-muted"
                    aria-label={tPhaseF('phaseF.componentsFolderViewSortSelector.clearSort')}
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {isSorted ? `Sorted by ${currentPropertyName}` : 'Sort'}
          </TooltipContent>
        </Tooltip>

        <PopoverContent align="start" className="w-72 p-0">
          {/* Header */}
          <div className="border-b px-3 py-2">
            <span className="text-xs font-semibold text-foreground">
              {tPhaseF('phaseF.componentsFolderViewSortSelector.sort')}
            </span>
          </div>

          {/* Search */}
          <div className="border-b p-2">
            <div className="relative">
              <Search className="absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={tPhaseF('phaseF.componentsFolderViewSortSelector.searchProperties')}
                className="h-8 ps-8 text-sm"
              />
            </div>
          </div>

          {/* Property List */}
          <div className="max-h-64 overflow-y-auto py-1">
            {filteredBuiltIn.length > 0 && (
              <div className="px-1.5 pb-1">
                <div className="px-1.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {tPhaseF('phaseF.componentsFolderViewSortSelector.builtIn')}
                </div>
                {filteredBuiltIn.map((col) => (
                  <PropertyRow
                    key={col.id}
                    name={col.displayName}
                    icon={getColumnIcon(col.id)}
                    isSelected={primary?.property === col.id}
                    onClick={() => handleSelectProperty(col.id)}
                  />
                ))}
              </div>
            )}

            {filteredProperties.length > 0 && (
              <div className="px-1.5 pb-1">
                <div className="px-1.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {tPhaseF('phaseF.componentsFolderViewSortSelector.properties')}
                </div>
                {filteredProperties.map((prop) => (
                  <PropertyRow
                    key={prop.name}
                    name={capitalizeFirst(prop.name)}
                    icon={getColumnIcon(prop.name)}
                    isSelected={primary?.property === prop.name}
                    onClick={() => handleSelectProperty(prop.name)}
                  />
                ))}
              </div>
            )}

            {filteredBuiltIn.length === 0 && filteredProperties.length === 0 && (
              <div className="px-2 py-4 text-center text-sm text-muted-foreground">
                {tPhaseF('phaseF.componentsFolderViewSortSelector.noSortablePropertiesFound')}
              </div>
            )}
          </div>

          {/* Direction toggle (when sorted) */}
          {isSorted && (
            <>
              <Separator />
              <div className="flex items-center justify-between p-2">
                <Label className="text-sm">
                  {tPhaseF('phaseF.componentsFolderViewSortSelector.sortDirection')}
                </Label>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleDirectionChange}
                  className="h-7 gap-1.5"
                >
                  {primary?.direction === 'asc' ? (
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
            </>
          )}

          {/* Clear sort */}
          {isSorted && (
            <>
              <Separator />
              <div className="p-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    onSortingChange([])
                    setIsOpen(false)
                  }}
                  className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                  {tPhaseF('phaseF.componentsFolderViewSortSelector.clearSort')}
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
  icon: AppIcon
  isSelected: boolean
  onClick: () => void
}

function PropertyRow({
  name,
  icon: Icon,
  isSelected,
  onClick
}: PropertyRowProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex h-7 w-full items-center gap-2 rounded-[6px] px-1.5 text-start transition-colors',
        isSelected ? 'bg-[var(--tint)]/10' : 'hover:bg-muted/60'
      )}
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{name}</span>
      {isSelected && <Check className="size-3.5 shrink-0 text-[var(--tint)]" />}
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

export default SortSelector
