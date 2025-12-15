/**
 * Inbox Header Component
 *
 * The header bar for the inbox page featuring:
 * - Title with item count badge
 * - Search input (expandable with recent queries)
 * - Filter popover
 * - View mode toggle (Compact/Medium/Expanded)
 */

import { Inbox } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ViewSwitcher } from './view-switcher'
import { SearchInput } from './search-input'
import { FilterPopover, type FilterState } from './filter-popover'
import type { InboxViewMode } from '@/data/inbox-types'

// ============================================================================
// TYPES
// ============================================================================

export interface InboxHeaderProps {
  /** Total number of items in inbox */
  itemCount: number
  /** Number of items captured today */
  todayCount: number
  /** Number of snoozed items */
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
  /** Callback to deselect all */
  onDeselectAll?: () => void
}

// ============================================================================
// ITEM COUNT BADGE
// ============================================================================

interface ItemCountBadgeProps {
  itemCount: number
  todayCount: number
  snoozedCount?: number
  onSnoozedClick?: () => void
}

function ItemCountBadge({
  itemCount,
  todayCount,
  snoozedCount,
  onSnoozedClick,
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
      {snoozedCount && snoozedCount > 0 && (
        <button
          type="button"
          onClick={onSnoozedClick}
          className={cn(
            'text-sm text-muted-foreground/80 hover:text-foreground',
            'cursor-pointer transition-colors duration-150'
          )}
        >
          {snoozedCount} snoozed
        </button>
      )}
    </div>
  )
}

// ============================================================================
// BULK MODE HEADER
// ============================================================================

interface BulkModeHeaderProps {
  selectedCount: number
  onDeselectAll: () => void
}

function BulkModeHeader({ selectedCount, onDeselectAll }: BulkModeHeaderProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-2">
        <div className="flex size-8 items-center justify-center rounded-full bg-primary/10">
          <span className="text-sm font-semibold text-primary">{selectedCount}</span>
        </div>
        <span className="text-sm font-medium text-foreground">
          {selectedCount === 1 ? 'item' : 'items'} selected
        </span>
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={onDeselectAll}
        className="h-7 text-xs text-muted-foreground hover:text-foreground"
      >
        Deselect all
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
  onDeselectAll,
}: InboxHeaderProps): React.JSX.Element {
  return (
    <header className="flex items-center justify-between px-6 py-4">
      {/* Left Section */}
      <div className="flex items-center gap-4">
        {isInBulkMode && selectedCount > 0 && onDeselectAll ? (
          <BulkModeHeader
            selectedCount={selectedCount}
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

            {/* Item count badge */}
            <ItemCountBadge
              itemCount={itemCount}
              todayCount={todayCount}
              snoozedCount={snoozedCount}
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
