/**
 * Inbox Header Component
 *
 * The header bar for the inbox page featuring:
 * - Title with item count badge
 * - Snoozed items indicator with popover
 * - Search input (expandable with recent queries)
 * - Filter popover
 * - View mode toggle (Compact/Medium/Expanded)
 * - Bulk mode transformation with selection controls
 */

import { Inbox } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ViewSwitcher } from './view-switcher'
import { SearchInput } from './search-input'
import { FilterPopover, type FilterState } from './filter-popover'
import { SnoozedIndicator } from './snoozed-indicator'
import type { InboxViewMode, InboxItem } from '@/data/inbox-types'

// ============================================================================
// TYPES
// ============================================================================

export interface InboxHeaderProps {
  /** Total number of items in inbox */
  itemCount: number
  /** Number of items captured today */
  todayCount: number
  /** All items (for snoozed indicator) */
  items?: InboxItem[]
  /** Number of snoozed items (used if items not provided) */
  snoozedCount?: number
  /** Current view mode */
  viewMode: InboxViewMode
  /** Callback when view mode changes */
  onViewModeChange: (mode: InboxViewMode) => void
  /** Current search query */
  searchQuery?: string
  /** Callback when search query changes */
  onSearchChange?: (query: string) => void
  /** Number of results for current search */
  searchResultCount?: number
  /** Current filter state */
  filters?: FilterState
  /** Callback when filters change */
  onFiltersChange?: (filters: FilterState) => void
  /** Whether filters are currently active */
  hasActiveFilters?: boolean
  /** Number of active filters */
  activeFilterCount?: number
  /** Whether in bulk selection mode */
  isInBulkMode?: boolean
  /** Number of selected items */
  selectedCount?: number
  /** Total number of visible items (for select all) */
  visibleItemCount?: number
  /** Whether all visible items are selected */
  isAllSelected?: boolean
  /** Whether some but not all items are selected */
  isPartiallySelected?: boolean
  /** Callback to select all */
  onSelectAll?: () => void
  /** Callback to deselect all */
  onDeselectAll?: () => void
  /** Callback when an item is unsnoozed from the indicator */
  onUnsnooze?: (itemId: string) => void
  /** Callback to preview an item from the snoozed indicator */
  onPreviewItem?: (itemId: string) => void
  /** Callback to view all snoozed items */
  onViewAllSnoozed?: () => void
}

// ============================================================================
// ITEM COUNT BADGE
// ============================================================================

interface ItemCountBadgeProps {
  itemCount: number
  todayCount: number
  items?: InboxItem[]
  snoozedCount?: number
  onUnsnooze?: (itemId: string) => void
  onPreviewItem?: (itemId: string) => void
  onViewAllSnoozed?: () => void
}

function ItemCountBadge({
  itemCount,
  todayCount,
  items,
  snoozedCount,
  onUnsnooze,
  onPreviewItem,
  onViewAllSnoozed,
}: ItemCountBadgeProps): React.JSX.Element {
  const parts: string[] = []

  parts.push(`${itemCount} ${itemCount === 1 ? 'item' : 'items'}`)

  if (todayCount > 0) {
    parts.push(`${todayCount} today`)
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-muted-foreground">
        {parts.join(' · ')}
      </span>
      {/* Snoozed Indicator - uses items if available, otherwise falls back to count */}
      {items ? (
        <SnoozedIndicator
          items={items}
          onUnsnooze={onUnsnooze}
          onPreview={onPreviewItem}
          onViewAll={onViewAllSnoozed}
        />
      ) : snoozedCount && snoozedCount > 0 ? (
        <span className="text-sm text-muted-foreground/80">
          · {snoozedCount} snoozed
        </span>
      ) : null}
    </div>
  )
}

// ============================================================================
// BULK MODE HEADER
// ============================================================================

interface BulkModeHeaderProps {
  selectedCount: number
  visibleItemCount: number
  isAllSelected: boolean
  isPartiallySelected: boolean
  onSelectAll: () => void
  onDeselectAll: () => void
}

function BulkModeHeader({
  selectedCount,
  visibleItemCount,
  isAllSelected,
  isPartiallySelected,
  onSelectAll,
  onDeselectAll,
}: BulkModeHeaderProps): React.JSX.Element {
  // Handle checkbox click - toggle between select all and deselect all
  const handleCheckboxChange = (checked: boolean | 'indeterminate') => {
    if (checked === true || checked === 'indeterminate') {
      onSelectAll()
    } else {
      onDeselectAll()
    }
  }

  return (
    <div className="flex items-center gap-4">
      {/* Select All Checkbox */}
      <div className="flex items-center gap-3">
        <Checkbox
          checked={isAllSelected ? true : isPartiallySelected ? 'indeterminate' : false}
          onCheckedChange={handleCheckboxChange}
          aria-label={isAllSelected ? 'Deselect all items' : 'Select all items'}
          className={cn(
            'size-5 rounded-[4px] border-2',
            'data-[state=checked]:bg-primary data-[state=checked]:border-primary',
            'data-[state=indeterminate]:bg-primary data-[state=indeterminate]:border-primary',
            'transition-all duration-150'
          )}
        />
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground tabular-nums">
            {selectedCount}
          </span>
          <span className="text-sm text-muted-foreground">
            of {visibleItemCount} selected
          </span>
        </div>
      </div>

      {/* Divider */}
      <div className="h-5 w-px bg-border/60" />

      {/* Deselect Button */}
      <Button
        variant="ghost"
        size="sm"
        onClick={onDeselectAll}
        className={cn(
          'h-8 px-3 text-sm',
          'text-muted-foreground hover:text-foreground',
          'hover:bg-accent/80',
          'transition-colors duration-150'
        )}
      >
        Clear selection
      </Button>
    </div>
  )
}

// ============================================================================
// MAIN HEADER COMPONENT
// ============================================================================

const DEFAULT_FILTERS: FilterState = {
  typeFilter: 'all',
  timeFilter: 'all',
  sortBy: 'newest',
}

export function InboxHeader({
  itemCount,
  todayCount,
  items,
  snoozedCount = 0,
  viewMode,
  onViewModeChange,
  searchQuery = '',
  onSearchChange,
  searchResultCount,
  filters = DEFAULT_FILTERS,
  onFiltersChange,
  hasActiveFilters = false,
  activeFilterCount = 0,
  isInBulkMode = false,
  selectedCount = 0,
  visibleItemCount = 0,
  isAllSelected = false,
  isPartiallySelected = false,
  onSelectAll,
  onDeselectAll,
  onUnsnooze,
  onPreviewItem,
  onViewAllSnoozed,
}: InboxHeaderProps): React.JSX.Element {
  return (
    <header
      className={cn(
        'flex items-center justify-between px-6 py-4',
        'transition-colors duration-200',
        // Subtle background change in bulk mode
        isInBulkMode && 'bg-accent/20'
      )}
    >
      {/* Left Section */}
      <div className="flex items-center gap-4">
        {isInBulkMode && selectedCount > 0 && onDeselectAll && onSelectAll ? (
          <BulkModeHeader
            selectedCount={selectedCount}
            visibleItemCount={visibleItemCount}
            isAllSelected={isAllSelected}
            isPartiallySelected={isPartiallySelected}
            onSelectAll={onSelectAll}
            onDeselectAll={onDeselectAll}
          />
        ) : (
          <>
            {/* Title with icon */}
            <div className="flex items-center gap-2.5">
              <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10">
                <Inbox className="size-5 text-primary" />
              </div>
              <div className="flex flex-col">
                <h1 className="text-xl font-semibold tracking-tight text-foreground">
                  Inbox
                </h1>
              </div>
            </div>

            {/* Separator */}
            <div className="h-6 w-px bg-border/60" />

            {/* Item count badge with snoozed indicator */}
            <ItemCountBadge
              itemCount={itemCount}
              todayCount={todayCount}
              items={items}
              snoozedCount={snoozedCount}
              onUnsnooze={onUnsnooze}
              onPreviewItem={onPreviewItem}
              onViewAllSnoozed={onViewAllSnoozed}
            />
          </>
        )}
      </div>

      {/* Right Section */}
      <div className="flex items-center gap-2">
        {/* Search Input */}
        <SearchInput
          value={searchQuery}
          onChange={(value) => onSearchChange?.(value)}
          resultCount={searchResultCount}
        />

        {/* Filter Popover */}
        <FilterPopover
          filters={filters}
          onFiltersChange={(newFilters) => onFiltersChange?.(newFilters)}
          hasActiveFilters={hasActiveFilters}
          activeFilterCount={activeFilterCount}
        />

        {/* Separator */}
        <div className="mx-1 h-6 w-px bg-border/60" />

        {/* View mode toggle */}
        <ViewSwitcher
          value={viewMode}
          onChange={onViewModeChange}
        />
      </div>
    </header>
  )
}
