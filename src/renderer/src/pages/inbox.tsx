/**
 * Inbox Page
 *
 * Displays captured items from browser extension, quick captures, and unprocessed content.
 * Supports three view modes: Compact, Medium, and Expanded.
 * Features robust selection system with shift-click range, cmd/ctrl multi-select.
 */

import { useState, useMemo, useCallback } from 'react'
import { cn } from '@/lib/utils'
import {
  InboxHeader,
  CompactView,
  MediumView,
  ExpandedView,
  EmptyState,
  ActiveFilters,
  getActiveFilterCount,
  type EmptyStateContext,
  type SnoozedItemPreview,
  type FilterState,
} from '@/components/inbox'
import {
  type InboxViewMode,
  type InboxFilters,
  type InboxItem,
  defaultInboxFilters,
  isItemSnoozed,
} from '@/data/inbox-types'
import { sampleInboxItems } from '@/data/sample-inbox'
import {
  useInboxSelection,
  useSelectionKeyboard,
} from '@/hooks/use-inbox-selection'

// =============================================================================
// TYPES
// =============================================================================

interface InboxPageState {
  viewMode: InboxViewMode
  filters: InboxFilters
  focusedItemId: string | null
}

// =============================================================================
// HOOKS
// =============================================================================

/**
 * Hook to manage inbox page state (excluding selection which is handled separately)
 */
function useInboxState() {
  const [state, setState] = useState<InboxPageState>({
    viewMode: 'medium',
    filters: defaultInboxFilters,
    focusedItemId: null,
  })

  const setViewMode = useCallback((viewMode: InboxViewMode) => {
    setState((prev) => ({ ...prev, viewMode }))
  }, [])

  const setFilters = useCallback((filters: InboxFilters) => {
    setState((prev) => ({ ...prev, filters }))
  }, [])

  const setSearchQuery = useCallback((search: string) => {
    setState((prev) => ({
      ...prev,
      filters: { ...prev.filters, search },
    }))
  }, [])

  const setTypeFilter = useCallback((typeFilter: InboxFilters['typeFilter']) => {
    setState((prev) => ({
      ...prev,
      filters: { ...prev.filters, typeFilter },
    }))
  }, [])

  const setTimeFilter = useCallback((timeFilter: InboxFilters['timeFilter']) => {
    setState((prev) => ({
      ...prev,
      filters: { ...prev.filters, timeFilter },
    }))
  }, [])

  const setSortBy = useCallback((sortBy: InboxFilters['sortBy']) => {
    setState((prev) => ({
      ...prev,
      filters: { ...prev.filters, sortBy },
    }))
  }, [])

  const resetFilters = useCallback(() => {
    setState((prev) => ({ ...prev, filters: defaultInboxFilters }))
  }, [])

  const setFocusedItemId = useCallback((focusedItemId: string | null) => {
    setState((prev) => ({ ...prev, focusedItemId }))
  }, [])

  return {
    ...state,
    setViewMode,
    setFilters,
    setSearchQuery,
    setTypeFilter,
    setTimeFilter,
    setSortBy,
    resetFilters,
    setFocusedItemId,
  }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Filter items based on current filters
 */
function filterItems(items: InboxItem[], filters: InboxFilters): InboxItem[] {
  let filtered = items

  // Filter out snoozed items unless showSnoozed is true
  if (!filters.showSnoozed) {
    filtered = filtered.filter((item) => !isItemSnoozed(item))
  }

  // Search filter
  if (filters.search) {
    const query = filters.search.toLowerCase()
    filtered = filtered.filter((item) =>
      item.title.toLowerCase().includes(query)
    )
  }

  // Type filter
  if (filters.typeFilter !== 'all') {
    filtered = filtered.filter((item) => item.type === filters.typeFilter)
  }

  // Time filter
  if (filters.timeFilter !== 'all') {
    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000)

    switch (filters.timeFilter) {
      case 'today':
        filtered = filtered.filter((item) => item.createdAt >= today)
        break
      case 'thisWeek':
        filtered = filtered.filter((item) => item.createdAt >= weekAgo)
        break
      case 'older':
        filtered = filtered.filter((item) => item.createdAt < weekAgo)
        break
      case 'stale':
        filtered = filtered.filter((item) => {
          const staleDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
          return (
            item.createdAt < staleDate &&
            item.folderId === null &&
            !isItemSnoozed(item)
          )
        })
        break
    }
  }

  // Sort
  switch (filters.sortBy) {
    case 'newest':
      filtered.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      break
    case 'oldest':
      filtered.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      break
    case 'type':
      filtered.sort((a, b) => a.type.localeCompare(b.type))
      break
    case 'title':
      filtered.sort((a, b) => a.title.localeCompare(b.title))
      break
  }

  return filtered
}

/**
 * Get counts for header badge
 */
function getItemCounts(items: InboxItem[]) {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())

  const visibleItems = items.filter((item) => !isItemSnoozed(item))
  const todayItems = visibleItems.filter((item) => item.createdAt >= today)
  const snoozedItems = items.filter((item) => isItemSnoozed(item))

  return {
    total: visibleItems.length,
    today: todayItems.length,
    snoozed: snoozedItems.length,
  }
}

/**
 * Check if any filters are active (beyond defaults)
 */
function hasActiveFiltersCheck(filters: InboxFilters): boolean {
  return (
    filters.search !== '' ||
    filters.typeFilter !== 'all' ||
    filters.timeFilter !== 'all' ||
    filters.sortBy !== 'newest' ||
    filters.tagIds.length > 0
  )
}

/**
 * Convert InboxFilters to FilterState for the header
 */
function toFilterState(filters: InboxFilters): FilterState {
  return {
    typeFilter: filters.typeFilter,
    timeFilter: filters.timeFilter,
    sortBy: filters.sortBy,
  }
}

/**
 * Get context for empty state determination
 */
function getEmptyStateContext(items: InboxItem[]): EmptyStateContext {
  // For demo purposes, we'll mock some stats
  // In a real app, these would come from a stats service
  const hasHistory = items.length > 0 || true // Assume user has some history

  // Mock: pretend user processed some items today
  const processedToday = 0 // Set to 0 to show "returning" state, or >0 for "inbox zero"

  // Get snoozed items for the returning state
  const snoozedItems: SnoozedItemPreview[] = items
    .filter((item) => isItemSnoozed(item))
    .slice(0, 5)
    .map((item) => ({
      id: item.id,
      type: item.type,
      title: item.title,
      returnsAt: item.snoozedUntil || new Date(),
    }))

  return {
    hasHistory,
    processedToday,
    stats: {
      processedToday,
      filedToday: 0,
      deletedToday: 0,
      snoozedToday: 0,
    },
    snoozedItems,
  }
}

// =============================================================================
// INBOX PAGE COMPONENT
// =============================================================================

export function InboxPage(): React.JSX.Element {
  // State management
  const {
    viewMode,
    filters,
    focusedItemId,
    setViewMode,
    setSearchQuery,
    setTypeFilter,
    setTimeFilter,
    setSortBy,
    resetFilters,
    setFocusedItemId,
  } = useInboxState()

  // Items (using sample data for now)
  const items = sampleInboxItems

  // Derived state
  const filteredItems = useMemo(
    () => filterItems(items, filters),
    [items, filters]
  )

  // Selection management (using the new hook)
  const selection = useInboxSelection(filteredItems)

  // Enable keyboard shortcuts for selection
  useSelectionKeyboard({
    focusedId: focusedItemId,
    toggleSelection: selection.toggleSelection,
    selectAll: selection.selectAll,
    deselectAll: selection.deselectAll,
    enabled: true,
  })

  const counts = useMemo(() => getItemCounts(items), [items])

  const hasFilters = hasActiveFiltersCheck(filters)
  const activeFilterCount = getActiveFilterCount(
    filters.typeFilter,
    filters.timeFilter,
    filters.sortBy,
    filters.search
  )

  // =========================================================================
  // FILTER HANDLERS
  // =========================================================================

  const handleFiltersChange = useCallback(
    (newFilters: FilterState) => {
      setTypeFilter(newFilters.typeFilter)
      setTimeFilter(newFilters.timeFilter)
      setSortBy(newFilters.sortBy)
    },
    [setTypeFilter, setTimeFilter, setSortBy]
  )

  const handleClearTypeFilter = useCallback(() => {
    setTypeFilter('all')
  }, [setTypeFilter])

  const handleClearTimeFilter = useCallback(() => {
    setTimeFilter('all')
  }, [setTimeFilter])

  const handleClearSort = useCallback(() => {
    setSortBy('newest')
  }, [setSortBy])

  const handleClearSearch = useCallback(() => {
    setSearchQuery('')
  }, [setSearchQuery])

  // =========================================================================
  // ITEM HANDLERS
  // =========================================================================

  // Handle item click with modifier key support
  const handleItemClick = useCallback(
    (
      id: string,
      event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }
    ) => {
      // Always update focus
      setFocusedItemId(id)

      // Delegate all selection logic to the selection hook
      // This ensures lastSelectedId is always tracked correctly
      selection.handleItemClick(id, event)
    },
    [setFocusedItemId, selection]
  )

  // Handle checkbox toggle (direct selection change without modifiers)
  const handleItemSelect = useCallback(
    (id: string, selected: boolean) => {
      if (selected) {
        selection.addToSelection([id])
      } else {
        selection.removeFromSelection([id])
      }
    },
    [selection]
  )

  const handleItemDoubleClick = useCallback(
    (id: string) => {
      // Open preview panel (to be implemented)
      console.log('Double-clicked item:', id)
    },
    []
  )

  const handleFile = useCallback(
    (ids: string[]) => {
      // Open filing panel (to be implemented)
      console.log('File items:', ids)
    },
    []
  )

  const handlePreview = useCallback(
    (id: string) => {
      // Open preview panel (to be implemented)
      console.log('Preview item:', id)
    },
    []
  )

  const handleOpenOriginal = useCallback(
    (id: string) => {
      // Open original link/file (to be implemented)
      console.log('Open original:', id)
    },
    []
  )

  const handleSnooze = useCallback(
    (ids: string[]) => {
      // Open snooze menu (to be implemented)
      console.log('Snooze items:', ids)
    },
    []
  )

  const handleDelete = useCallback(
    (ids: string[]) => {
      // Delete items (to be implemented)
      console.log('Delete items:', ids)
    },
    []
  )

  const handleAcceptSuggestion = useCallback(
    (id: string, folderId: string) => {
      // Accept AI suggestion and file to folder (to be implemented)
      console.log('Accept suggestion for item:', id, 'to folder:', folderId)
    },
    []
  )

  const handleDismissSuggestion = useCallback(
    (id: string) => {
      // Dismiss AI suggestion (to be implemented)
      console.log('Dismiss suggestion for item:', id)
    },
    []
  )

  const handleAddTag = useCallback(
    (id: string, tag: string) => {
      // Add tag to item (to be implemented)
      console.log('Add tag to item:', id, 'tag:', tag)
    },
    []
  )

  const handleRemoveTag = useCallback(
    (id: string, tag: string) => {
      // Remove tag from item (to be implemented)
      console.log('Remove tag from item:', id, 'tag:', tag)
    },
    []
  )

  const handleFocusChange = useCallback(
    (id: string | null) => {
      setFocusedItemId(id)
    },
    [setFocusedItemId]
  )

  const handleCapture = useCallback(() => {
    // Open capture dialog or focus on paste listener (to be implemented)
    console.log('Open capture dialog')
  }, [])

  const handleViewSnoozed = useCallback(() => {
    // Navigate to snoozed items view (to be implemented)
    console.log('View snoozed items')
  }, [])

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <InboxHeader
        itemCount={counts.total}
        todayCount={counts.today}
        snoozedCount={counts.snoozed}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        searchQuery={filters.search}
        onSearchChange={setSearchQuery}
        searchResultCount={filters.search ? filteredItems.length : undefined}
        filters={toFilterState(filters)}
        onFiltersChange={handleFiltersChange}
        hasActiveFilters={hasFilters}
        activeFilterCount={activeFilterCount}
        isInBulkMode={selection.isInBulkMode}
        selectedCount={selection.selectedCount}
        visibleItemCount={filteredItems.length}
        isAllSelected={selection.isAllSelected}
        isPartiallySelected={selection.isPartiallySelected}
        onSelectAll={selection.selectAll}
        onDeselectAll={selection.deselectAll}
      />

      {/* Active Filters Bar */}
      <ActiveFilters
        typeFilter={filters.typeFilter}
        timeFilter={filters.timeFilter}
        sortBy={filters.sortBy}
        searchQuery={filters.search}
        onClearTypeFilter={handleClearTypeFilter}
        onClearTimeFilter={handleClearTimeFilter}
        onClearSort={handleClearSort}
        onClearSearch={handleClearSearch}
        onClearAll={resetFilters}
      />

      {/* Content Area */}
      <div
        className={cn(
          'flex-1 overflow-y-auto',
          'scrollbar-thin scrollbar-track-transparent scrollbar-thumb-border'
        )}
      >
        {filteredItems.length === 0 ? (
          hasFilters ? (
            // Filters active but no results
            <div className="flex h-64 items-center justify-center">
              <p className="text-sm text-muted-foreground">
                No items match your filters
              </p>
            </div>
          ) : (
            // True empty state - use EmptyState component
            <EmptyState
              context={getEmptyStateContext(items)}
              onCapture={handleCapture}
              onViewSnoozed={handleViewSnoozed}
            />
          )
        ) : (
          <>
            {/* Compact View */}
            {viewMode === 'compact' && (
              <CompactView
                items={filteredItems}
                selectedIds={selection.selectedIds}
                focusedId={focusedItemId}
                isBulkMode={selection.isInBulkMode}
                onItemSelect={handleItemSelect}
                onItemClick={handleItemClick}
                onItemDoubleClick={handleItemDoubleClick}
                onFile={handleFile}
                onPreview={handlePreview}
                onOpenOriginal={handleOpenOriginal}
                onSnooze={handleSnooze}
                onDelete={handleDelete}
              />
            )}

            {/* Medium View */}
            {viewMode === 'medium' && (
              <MediumView
                items={filteredItems}
                selectedIds={selection.selectedIds}
                focusedId={focusedItemId}
                isBulkMode={selection.isInBulkMode}
                onItemSelect={handleItemSelect}
                onItemClick={handleItemClick}
                onItemDoubleClick={handleItemDoubleClick}
                onFile={handleFile}
                onPreview={handlePreview}
                onOpenOriginal={handleOpenOriginal}
                onSnooze={handleSnooze}
                onDelete={handleDelete}
              />
            )}

            {/* Expanded View */}
            {viewMode === 'expanded' && (
              <ExpandedView
                items={filteredItems}
                focusedId={focusedItemId}
                onFocusChange={handleFocusChange}
                onFile={handleFile}
                onOpenOriginal={handleOpenOriginal}
                onSnooze={handleSnooze}
                onDelete={handleDelete}
                onAcceptSuggestion={handleAcceptSuggestion}
                onDismissSuggestion={handleDismissSuggestion}
                onAddTag={handleAddTag}
                onRemoveTag={handleRemoveTag}
              />
            )}
          </>
        )}
      </div>

      {/* Bulk Action Bar Area - placeholder for future implementation */}
      {selection.isInBulkMode && (
        <div
          className={cn(
            'border-t border-border bg-background/95 backdrop-blur',
            'px-6 py-4'
          )}
        >
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium tabular-nums">
              {selection.selectedCount}{' '}
              {selection.selectedCount === 1 ? 'item' : 'items'} selected
            </span>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              Bulk actions will be implemented in prompt 12
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
