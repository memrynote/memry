/**
 * Active Filters Component
 *
 * Displays currently applied filters as removable pills.
 * Shows below the header when filters are active.
 */

import { useMemo } from 'react'
import {
  X,
  Link2,
  FileText,
  Image,
  Mic,
  Scissors,
  File,
  Video,
  Calendar,
  AlertTriangle,
  ArrowUpDown,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type {
  InboxItemType,
  InboxTypeFilter,
  InboxTimeFilter,
  InboxSortOption,
} from '@/data/inbox-types'

// ============================================================================
// TYPES
// ============================================================================

export interface ActiveFiltersProps {
  /** Current type filter */
  typeFilter: InboxTypeFilter
  /** Current time filter */
  timeFilter: InboxTimeFilter
  /** Current sort option */
  sortBy: InboxSortOption
  /** Current search query */
  searchQuery?: string
  /** Callback to clear type filter */
  onClearTypeFilter: () => void
  /** Callback to clear time filter */
  onClearTimeFilter: () => void
  /** Callback to clear sort (reset to default) */
  onClearSort: () => void
  /** Callback to clear search */
  onClearSearch?: () => void
  /** Callback to clear all filters */
  onClearAll: () => void
  /** Additional class names */
  className?: string
}

// ============================================================================
// CONSTANTS
// ============================================================================

const TYPE_ICONS: Record<InboxItemType, React.ElementType> = {
  link: Link2,
  note: FileText,
  image: Image,
  voice: Mic,
  pdf: FileText,
  webclip: Scissors,
  file: File,
  video: Video,
}

const TYPE_LABELS: Record<InboxItemType, string> = {
  link: 'Links',
  note: 'Notes',
  image: 'Images',
  voice: 'Voice',
  pdf: 'PDFs',
  webclip: 'Clips',
  file: 'Files',
  video: 'Videos',
}

const TIME_LABELS: Record<InboxTimeFilter, string> = {
  all: 'All time',
  today: 'Today',
  thisWeek: 'This week',
  older: 'Older',
  stale: 'Stale (7d+)',
}

const SORT_LABELS: Record<InboxSortOption, string> = {
  newest: 'Newest',
  oldest: 'Oldest',
  type: 'By type',
  title: 'By title',
}

// ============================================================================
// FILTER PILL COMPONENT
// ============================================================================

interface FilterPillProps {
  icon?: React.ElementType
  label: string
  value: string
  onClear: () => void
  variant?: 'default' | 'warning' | 'search'
}

function FilterPill({
  icon: Icon,
  label,
  value,
  onClear,
  variant = 'default',
}: FilterPillProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1',
        'text-xs font-medium',
        'border transition-colors duration-150',
        'animate-in fade-in-0 zoom-in-95 duration-200',
        variant === 'default' && 'border-border/60 bg-background text-foreground',
        variant === 'warning' && 'border-amber-500/40 bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400',
        variant === 'search' && 'border-blue-500/40 bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-400'
      )}
    >
      {Icon && <Icon className="size-3" />}
      <span className="text-muted-foreground">{label}:</span>
      <span>{value}</span>
      <button
        type="button"
        onClick={onClear}
        className={cn(
          'ml-0.5 rounded-full p-0.5',
          'hover:bg-foreground/10 transition-colors',
          'focus:outline-none focus:ring-1 focus:ring-ring'
        )}
        aria-label={`Clear ${label} filter`}
      >
        <X className="size-3" />
      </button>
    </div>
  )
}

// ============================================================================
// ACTIVE FILTERS COMPONENT
// ============================================================================

export function ActiveFilters({
  typeFilter,
  timeFilter,
  sortBy,
  searchQuery,
  onClearTypeFilter,
  onClearTimeFilter,
  onClearSort,
  onClearSearch,
  onClearAll,
  className,
}: ActiveFiltersProps): React.JSX.Element | null {
  // Compute which filters are active (non-default)
  const activeFilters = useMemo(() => {
    const filters: Array<{
      key: string
      icon?: React.ElementType
      label: string
      value: string
      onClear: () => void
      variant?: 'default' | 'warning' | 'search'
    }> = []

    // Search
    if (searchQuery && searchQuery.trim()) {
      filters.push({
        key: 'search',
        label: 'Search',
        value: `"${searchQuery}"`,
        onClear: onClearSearch ?? (() => {}),
        variant: 'search',
      })
    }

    // Type filter
    if (typeFilter !== 'all') {
      const TypeIcon = TYPE_ICONS[typeFilter]
      filters.push({
        key: 'type',
        icon: TypeIcon,
        label: 'Type',
        value: TYPE_LABELS[typeFilter],
        onClear: onClearTypeFilter,
      })
    }

    // Time filter
    if (timeFilter !== 'all') {
      filters.push({
        key: 'time',
        icon: timeFilter === 'stale' ? AlertTriangle : Calendar,
        label: 'Time',
        value: TIME_LABELS[timeFilter],
        onClear: onClearTimeFilter,
        variant: timeFilter === 'stale' ? 'warning' : 'default',
      })
    }

    // Sort (only show if not default)
    if (sortBy !== 'newest') {
      filters.push({
        key: 'sort',
        icon: ArrowUpDown,
        label: 'Sort',
        value: SORT_LABELS[sortBy],
        onClear: onClearSort,
      })
    }

    return filters
  }, [
    typeFilter,
    timeFilter,
    sortBy,
    searchQuery,
    onClearTypeFilter,
    onClearTimeFilter,
    onClearSort,
    onClearSearch,
  ])

  // Don't render if no active filters
  if (activeFilters.length === 0) {
    return null
  }

  return (
    <div
      className={cn(
        'flex items-center gap-2 border-b border-border/50 bg-muted/20 px-6 py-2.5',
        'animate-in slide-in-from-top-2 fade-in-0 duration-200',
        className
      )}
    >
      <span className="shrink-0 text-xs font-medium text-muted-foreground">
        Active:
      </span>

      <div className="flex flex-1 flex-wrap items-center gap-1.5">
        {activeFilters.map((filter) => (
          <FilterPill
            key={filter.key}
            icon={filter.icon}
            label={filter.label}
            value={filter.value}
            onClear={filter.onClear}
            variant={filter.variant}
          />
        ))}
      </div>

      <Button
        variant="ghost"
        size="sm"
        onClick={onClearAll}
        className="h-7 shrink-0 text-xs text-muted-foreground hover:text-foreground"
      >
        Clear all
      </Button>
    </div>
  )
}

// ============================================================================
// HELPER FUNCTION
// ============================================================================

/**
 * Calculate the number of active filters
 */
export function getActiveFilterCount(
  typeFilter: InboxTypeFilter,
  timeFilter: InboxTimeFilter,
  sortBy: InboxSortOption,
  searchQuery?: string
): number {
  let count = 0
  if (searchQuery && searchQuery.trim()) count++
  if (typeFilter !== 'all') count++
  if (timeFilter !== 'all') count++
  if (sortBy !== 'newest') count++
  return count
}

/**
 * Check if any filters are active (non-default)
 */
export function hasActiveFilters(
  typeFilter: InboxTypeFilter,
  timeFilter: InboxTimeFilter,
  sortBy: InboxSortOption,
  searchQuery?: string
): boolean {
  return getActiveFilterCount(typeFilter, timeFilter, sortBy, searchQuery) > 0
}
