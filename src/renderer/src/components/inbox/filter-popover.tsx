/**
 * Filter Popover Component
 *
 * A comprehensive filter panel with:
 * - Type filters (multi-select)
 * - Time range filters (single-select)
 * - Sort options
 * - Reset and Apply buttons
 */

import { useState, useCallback, useMemo } from 'react'
import {
  SlidersHorizontal,
  RotateCcw,
  Check,
  Link2,
  FileText,
  Image,
  Mic,
  Scissors,
  File,
  Video,
  ChevronDown,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Toggle } from '@/components/ui/toggle'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'
import type {
  InboxItemType,
  InboxTypeFilter,
  InboxTimeFilter,
  InboxSortOption,
} from '@/data/inbox-types'

// ============================================================================
// TYPES
// ============================================================================

export interface FilterState {
  typeFilter: InboxTypeFilter
  timeFilter: InboxTimeFilter
  sortBy: InboxSortOption
}

export interface FilterPopoverProps {
  /** Current filter state */
  filters: FilterState
  /** Callback when filters change */
  onFiltersChange: (filters: FilterState) => void
  /** Whether any filters are active (non-default) */
  hasActiveFilters?: boolean
  /** Number of active filters */
  activeFilterCount?: number
  /** Additional class names */
  className?: string
}

// ============================================================================
// CONSTANTS
// ============================================================================

const TYPE_OPTIONS: Array<{ value: InboxItemType; label: string; icon: React.ElementType }> = [
  { value: 'link', label: 'Links', icon: Link2 },
  { value: 'note', label: 'Notes', icon: FileText },
  { value: 'image', label: 'Images', icon: Image },
  { value: 'voice', label: 'Voice', icon: Mic },
  { value: 'pdf', label: 'PDFs', icon: FileText },
  { value: 'webclip', label: 'Clips', icon: Scissors },
  { value: 'file', label: 'Files', icon: File },
  { value: 'video', label: 'Videos', icon: Video },
]

const TIME_OPTIONS: Array<{ value: InboxTimeFilter; label: string; description?: string }> = [
  { value: 'all', label: 'All time' },
  { value: 'today', label: 'Today', description: 'Captured today' },
  { value: 'thisWeek', label: 'This week', description: 'Last 7 days' },
  { value: 'older', label: 'Older', description: 'More than 7 days' },
  { value: 'stale', label: 'Stale', description: '7+ days unfiled' },
]

const SORT_OPTIONS: Array<{ value: InboxSortOption; label: string }> = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'type', label: 'By type' },
  { value: 'title', label: 'By title' },
]

const DEFAULT_FILTERS: FilterState = {
  typeFilter: 'all',
  timeFilter: 'all',
  sortBy: 'newest',
}

// ============================================================================
// TYPE FILTER SECTION
// ============================================================================

interface TypeFilterSectionProps {
  value: InboxTypeFilter
  onChange: (value: InboxTypeFilter) => void
}

function TypeFilterSection({ value, onChange }: TypeFilterSectionProps): React.JSX.Element {
  const isAll = value === 'all'

  const handleTypeToggle = (type: InboxItemType) => {
    if (value === 'all') {
      // If all, switch to single type
      onChange(type)
    } else if (value === type) {
      // If same type, switch back to all
      onChange('all')
    } else {
      // Switch to different type
      onChange(type)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Type
        </span>
        {!isAll && (
          <button
            type="button"
            onClick={() => onChange('all')}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Clear
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {/* All button */}
        <Toggle
          pressed={isAll}
          onPressedChange={() => onChange('all')}
          size="sm"
          className={cn(
            'h-8 px-3 rounded-full text-xs font-medium',
            'border border-transparent',
            'data-[state=on]:bg-primary data-[state=on]:text-primary-foreground',
            'data-[state=on]:border-primary',
            'hover:bg-accent/60'
          )}
        >
          All
        </Toggle>

        {/* Type buttons */}
        {TYPE_OPTIONS.map((option) => {
          const Icon = option.icon
          const isActive = value === option.value

          return (
            <Toggle
              key={option.value}
              pressed={isActive}
              onPressedChange={() => handleTypeToggle(option.value)}
              size="sm"
              className={cn(
                'h-8 px-3 rounded-full text-xs font-medium gap-1.5',
                'border border-transparent',
                'data-[state=on]:bg-primary data-[state=on]:text-primary-foreground',
                'data-[state=on]:border-primary',
                'hover:bg-accent/60'
              )}
            >
              <Icon className="size-3.5" />
              {option.label}
            </Toggle>
          )
        })}
      </div>
    </div>
  )
}

// ============================================================================
// TIME FILTER SECTION
// ============================================================================

interface TimeFilterSectionProps {
  value: InboxTimeFilter
  onChange: (value: InboxTimeFilter) => void
}

function TimeFilterSection({ value, onChange }: TimeFilterSectionProps): React.JSX.Element {
  return (
    <div className="space-y-3">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Time Range
      </span>

      <div className="flex flex-wrap gap-1.5">
        {TIME_OPTIONS.map((option) => (
          <Toggle
            key={option.value}
            pressed={value === option.value}
            onPressedChange={() => onChange(option.value)}
            size="sm"
            className={cn(
              'h-8 px-3 rounded-full text-xs font-medium',
              'border border-transparent',
              'data-[state=on]:bg-primary data-[state=on]:text-primary-foreground',
              'data-[state=on]:border-primary',
              'hover:bg-accent/60',
              option.value === 'stale' && 'data-[state=on]:bg-amber-600 data-[state=on]:border-amber-600'
            )}
          >
            {option.label}
          </Toggle>
        ))}
      </div>
    </div>
  )
}

// ============================================================================
// SORT SECTION
// ============================================================================

interface SortSectionProps {
  value: InboxSortOption
  onChange: (value: InboxSortOption) => void
}

function SortSection({ value, onChange }: SortSectionProps): React.JSX.Element {
  return (
    <div className="space-y-3">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Sort By
      </span>

      <RadioGroup
        value={value}
        onValueChange={(v) => onChange(v as InboxSortOption)}
        className="grid grid-cols-2 gap-2"
      >
        {SORT_OPTIONS.map((option) => (
          <div
            key={option.value}
            className={cn(
              'flex items-center space-x-2 rounded-md border px-3 py-2',
              'cursor-pointer transition-colors duration-150',
              value === option.value
                ? 'border-primary/50 bg-primary/5'
                : 'border-border/60 hover:bg-accent/30'
            )}
          >
            <RadioGroupItem value={option.value} id={`sort-${option.value}`} />
            <Label
              htmlFor={`sort-${option.value}`}
              className="text-sm font-normal cursor-pointer flex-1"
            >
              {option.label}
            </Label>
          </div>
        ))}
      </RadioGroup>
    </div>
  )
}

// ============================================================================
// FILTER POPOVER COMPONENT
// ============================================================================

export function FilterPopover({
  filters,
  onFiltersChange,
  hasActiveFilters = false,
  activeFilterCount = 0,
  className,
}: FilterPopoverProps): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false)
  const [localFilters, setLocalFilters] = useState<FilterState>(filters)

  // Sync local state when popover opens
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        setLocalFilters(filters)
      }
      setIsOpen(open)
    },
    [filters]
  )

  // Apply filters and close
  const handleApply = useCallback(() => {
    onFiltersChange(localFilters)
    setIsOpen(false)
  }, [localFilters, onFiltersChange])

  // Reset to defaults
  const handleReset = useCallback(() => {
    setLocalFilters(DEFAULT_FILTERS)
  }, [])

  // Check if current local filters differ from defaults
  const hasChanges = useMemo(() => {
    return (
      localFilters.typeFilter !== DEFAULT_FILTERS.typeFilter ||
      localFilters.timeFilter !== DEFAULT_FILTERS.timeFilter ||
      localFilters.sortBy !== DEFAULT_FILTERS.sortBy
    )
  }, [localFilters])

  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            'size-9 rounded-lg relative',
            hasActiveFilters && 'text-primary',
            className
          )}
          aria-label={`Filters${activeFilterCount > 0 ? ` (${activeFilterCount} active)` : ''}`}
        >
          <SlidersHorizontal className="size-4" />
          {hasActiveFilters && (
            <span
              className={cn(
                'absolute -right-0.5 -top-0.5',
                'flex size-4 items-center justify-center',
                'rounded-full bg-primary text-[10px] font-medium text-primary-foreground'
              )}
            >
              {activeFilterCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent
        className="w-80 p-0"
        align="end"
        sideOffset={8}
      >
        <div className="flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border/50 px-4 py-3">
            <span className="text-sm font-medium">Filters</span>
            {hasChanges && (
              <button
                type="button"
                onClick={handleReset}
                className={cn(
                  'flex items-center gap-1 text-xs text-muted-foreground',
                  'hover:text-foreground transition-colors'
                )}
              >
                <RotateCcw className="size-3" />
                Reset
              </button>
            )}
          </div>

          {/* Filter sections */}
          <div className="space-y-5 p-4">
            <TypeFilterSection
              value={localFilters.typeFilter}
              onChange={(typeFilter) =>
                setLocalFilters((prev) => ({ ...prev, typeFilter }))
              }
            />

            <div className="h-px bg-border/50" />

            <TimeFilterSection
              value={localFilters.timeFilter}
              onChange={(timeFilter) =>
                setLocalFilters((prev) => ({ ...prev, timeFilter }))
              }
            />

            <div className="h-px bg-border/50" />

            <SortSection
              value={localFilters.sortBy}
              onChange={(sortBy) =>
                setLocalFilters((prev) => ({ ...prev, sortBy }))
              }
            />
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 border-t border-border/50 px-4 py-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsOpen(false)}
              className="h-8"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleApply}
              className="h-8"
            >
              Apply Filters
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ============================================================================
// FILTER DROPDOWN (Alternative compact version)
// ============================================================================

export interface FilterDropdownProps {
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
  className?: string
}

export function FilterDropdown({
  label,
  value,
  options,
  onChange,
  className,
}: FilterDropdownProps): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false)
  const selectedOption = options.find((o) => o.value === value)

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            'h-8 gap-1.5 text-xs',
            value !== options[0]?.value && 'border-primary/50 bg-primary/5',
            className
          )}
        >
          <span className="text-muted-foreground">{label}:</span>
          <span className="font-medium">{selectedOption?.label ?? value}</span>
          <ChevronDown className="size-3 text-muted-foreground" />
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-40 p-1" align="start" sideOffset={4}>
        <div className="flex flex-col">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                onChange(option.value)
                setIsOpen(false)
              }}
              className={cn(
                'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm',
                'hover:bg-accent transition-colors',
                value === option.value && 'bg-accent'
              )}
            >
              {value === option.value && <Check className="size-3.5" />}
              <span className={value !== option.value ? 'ml-5' : ''}>
                {option.label}
              </span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
