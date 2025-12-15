/**
 * Search Input Component
 *
 * An enhanced expandable search input with:
 * - Recent search history
 * - Instant filtering (debounced)
 * - Keyboard shortcuts (/ to focus, Escape to close)
 * - Results count display
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { Search, X, Clock, ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'

// ============================================================================
// CONSTANTS
// ============================================================================

const MAX_RECENT_SEARCHES = 5
const DEBOUNCE_DELAY = 150 // ms

// ============================================================================
// TYPES
// ============================================================================

export interface SearchInputProps {
  /** Current search value */
  value: string
  /** Callback when search value changes (debounced) */
  onChange: (value: string) => void
  /** Number of results for current query */
  resultCount?: number
  /** Recent search queries */
  recentSearches?: string[]
  /** Callback to clear recent searches */
  onClearRecentSearches?: () => void
  /** Callback when a recent search is selected */
  onSelectRecentSearch?: (query: string) => void
  /** Placeholder text */
  placeholder?: string
  /** Additional class names */
  className?: string
}

// ============================================================================
// HOOKS
// ============================================================================

/**
 * Hook for managing recent searches in localStorage
 */
function useRecentSearches(storageKey: string = 'inbox-recent-searches') {
  const [recentSearches, setRecentSearches] = useState<string[]>([])

  // Load from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(storageKey)
      if (stored) {
        setRecentSearches(JSON.parse(stored))
      }
    } catch {
      // Ignore localStorage errors
    }
  }, [storageKey])

  const addSearch = useCallback(
    (query: string) => {
      const trimmed = query.trim()
      if (!trimmed) return

      setRecentSearches((prev) => {
        // Remove duplicate if exists
        const filtered = prev.filter((s) => s !== trimmed)
        // Add to front, limit to max
        const updated = [trimmed, ...filtered].slice(0, MAX_RECENT_SEARCHES)
        // Persist
        try {
          localStorage.setItem(storageKey, JSON.stringify(updated))
        } catch {
          // Ignore
        }
        return updated
      })
    },
    [storageKey]
  )

  const clearSearches = useCallback(() => {
    setRecentSearches([])
    try {
      localStorage.removeItem(storageKey)
    } catch {
      // Ignore
    }
  }, [storageKey])

  return { recentSearches, addSearch, clearSearches }
}

// ============================================================================
// RECENT SEARCHES DROPDOWN
// ============================================================================

interface RecentSearchesListProps {
  searches: string[]
  onSelect: (query: string) => void
  onClear: () => void
}

function RecentSearchesList({
  searches,
  onSelect,
  onClear,
}: RecentSearchesListProps): React.JSX.Element | null {
  if (searches.length === 0) {
    return (
      <div className="px-3 py-4 text-center text-sm text-muted-foreground">
        No recent searches
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/50 px-3 py-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Recent Searches
        </span>
        <button
          type="button"
          onClick={onClear}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          Clear
        </button>
      </div>

      {/* Search items */}
      <div className="py-1">
        {searches.map((query, index) => (
          <button
            key={`${query}-${index}`}
            type="button"
            onClick={() => onSelect(query)}
            className={cn(
              'flex w-full items-center gap-2.5 px-3 py-2',
              'text-sm text-left',
              'hover:bg-accent/50 transition-colors duration-150',
              'group'
            )}
          >
            <Clock className="size-3.5 text-muted-foreground/60" />
            <span className="flex-1 truncate">{query}</span>
            <ArrowRight className="size-3.5 text-muted-foreground/40 opacity-0 group-hover:opacity-100 transition-opacity" />
          </button>
        ))}
      </div>
    </div>
  )
}

// ============================================================================
// SEARCH INPUT COMPONENT
// ============================================================================

export function SearchInput({
  value,
  onChange,
  resultCount,
  recentSearches: externalRecentSearches,
  onClearRecentSearches: externalClearRecent,
  onSelectRecentSearch,
  placeholder = 'Search inbox...',
  className,
}: SearchInputProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const [isExpanded, setIsExpanded] = useState(false)
  const [localValue, setLocalValue] = useState(value)
  const [isDropdownOpen, setIsDropdownOpen] = useState(false)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Use internal recent searches if not provided externally
  const {
    recentSearches: internalRecentSearches,
    addSearch,
    clearSearches,
  } = useRecentSearches()

  const recentSearches = externalRecentSearches ?? internalRecentSearches
  const handleClearRecent = externalClearRecent ?? clearSearches

  // Sync external value changes (only when different)
  useEffect(() => {
    if (value !== localValue) {
      setLocalValue(value)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  // Global keyboard shortcut for /
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent): void => {
      // Don't trigger if already in an input
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return
      }

      if (e.key === '/') {
        e.preventDefault()
        setIsExpanded(true)
        setTimeout(() => inputRef.current?.focus(), 50)
      }
    }

    document.addEventListener('keydown', handleGlobalKeyDown)
    return () => document.removeEventListener('keydown', handleGlobalKeyDown)
  }, [])

  // Focus input when expanded
  useEffect(() => {
    if (isExpanded) {
      inputRef.current?.focus()
    }
  }, [isExpanded])

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
    }
  }, [])

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value
      setLocalValue(newValue)

      // Clear existing timer
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }

      // Set new debounce timer
      debounceTimerRef.current = setTimeout(() => {
        onChange(newValue)
      }, DEBOUNCE_DELAY)
    },
    [onChange]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (localValue) {
          // First escape clears the search
          setLocalValue('')
          onChange('')
          if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current)
          }
        } else {
          // Second escape closes the input
          setIsExpanded(false)
          setIsDropdownOpen(false)
        }
      } else if (e.key === 'Enter' && localValue.trim()) {
        // Save to recent searches on Enter
        addSearch(localValue.trim())
        setIsDropdownOpen(false)
      }
    },
    [localValue, onChange, addSearch]
  )

  const handleClear = useCallback(() => {
    setLocalValue('')
    onChange('')
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }
    inputRef.current?.focus()
  }, [onChange])

  const handleToggle = useCallback(() => {
    if (isExpanded) {
      setLocalValue('')
      onChange('')
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
      setIsExpanded(false)
      setIsDropdownOpen(false)
    } else {
      setIsExpanded(true)
    }
  }, [isExpanded, onChange])

  const handleSelectRecent = useCallback(
    (query: string) => {
      setLocalValue(query)
      onChange(query)
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
      setIsDropdownOpen(false)
      onSelectRecentSearch?.(query)
      inputRef.current?.focus()
    },
    [onChange, onSelectRecentSearch]
  )

  const handleFocus = useCallback(() => {
    if (!localValue && recentSearches.length > 0) {
      setIsDropdownOpen(true)
    }
  }, [localValue, recentSearches.length])

  const handleBlur = useCallback(() => {
    // Delay closing to allow clicking on dropdown items
    setTimeout(() => {
      setIsDropdownOpen(false)
    }, 200)
  }, [])

  // Show results count when searching
  const showResultsCount = localValue.trim().length > 0 && resultCount !== undefined

  return (
    <div className={cn('flex items-center gap-1', className)}>
      {/* Expanded search input */}
      <div
        className={cn(
          'flex items-center overflow-hidden transition-all duration-300 ease-out',
          isExpanded ? 'w-72' : 'w-0'
        )}
      >
        <Popover open={isDropdownOpen && !localValue && recentSearches.length > 0}>
          <PopoverTrigger asChild>
            <div className="relative flex w-full items-center">
              <Search className="absolute left-3 size-4 text-muted-foreground pointer-events-none" />
              <Input
                ref={inputRef}
                type="text"
                placeholder={placeholder}
                value={localValue}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                onFocus={handleFocus}
                onBlur={handleBlur}
                className={cn(
                  'h-9 w-full pl-9',
                  localValue ? 'pr-20' : 'pr-8',
                  'bg-muted/40 border-transparent',
                  'focus:bg-background focus:border-border focus:ring-1 focus:ring-ring/20',
                  'placeholder:text-muted-foreground/60',
                  'transition-all duration-200'
                )}
              />

              {/* Results count / Clear button */}
              <div className="absolute right-2 flex items-center gap-1">
                {showResultsCount && (
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {resultCount} {resultCount === 1 ? 'result' : 'results'}
                  </span>
                )}
                {localValue && (
                  <button
                    type="button"
                    onClick={handleClear}
                    className={cn(
                      'rounded p-0.5',
                      'text-muted-foreground hover:text-foreground',
                      'transition-colors duration-150'
                    )}
                    aria-label="Clear search"
                  >
                    <X className="size-3.5" />
                  </button>
                )}
              </div>
            </div>
          </PopoverTrigger>

          <PopoverContent
            className="w-72 p-0"
            align="start"
            sideOffset={4}
            onOpenAutoFocus={(e) => e.preventDefault()}
          >
            <RecentSearchesList
              searches={recentSearches}
              onSelect={handleSelectRecent}
              onClear={handleClearRecent}
            />
          </PopoverContent>
        </Popover>
      </div>

      {/* Search toggle button */}
      <Button
        variant="ghost"
        size="icon"
        onClick={handleToggle}
        className={cn(
          'size-9 rounded-lg shrink-0',
          isExpanded && 'bg-muted'
        )}
        aria-label={isExpanded ? 'Close search' : 'Open search'}
      >
        {isExpanded ? <X className="size-4" /> : <Search className="size-4" />}
      </Button>
    </div>
  )
}

// ============================================================================
// STANDALONE SEARCH INPUT (for use outside header)
// ============================================================================

export interface StandaloneSearchInputProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
  autoFocus?: boolean
}

export function StandaloneSearchInput({
  value,
  onChange,
  placeholder = 'Search...',
  className,
  autoFocus = false,
}: StandaloneSearchInputProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const [localValue, setLocalValue] = useState(value)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Sync external value changes
  useEffect(() => {
    if (value !== localValue) {
      setLocalValue(value)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  useEffect(() => {
    if (autoFocus) {
      inputRef.current?.focus()
    }
  }, [autoFocus])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
    }
  }, [])

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value
      setLocalValue(newValue)

      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }

      debounceTimerRef.current = setTimeout(() => {
        onChange(newValue)
      }, DEBOUNCE_DELAY)
    },
    [onChange]
  )

  const handleClear = useCallback(() => {
    setLocalValue('')
    onChange('')
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }
    inputRef.current?.focus()
  }, [onChange])

  return (
    <div className={cn('relative', className)}>
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
      <Input
        ref={inputRef}
        type="text"
        placeholder={placeholder}
        value={localValue}
        onChange={handleChange}
        className={cn(
          'pl-9 pr-8',
          'bg-muted/40 border-transparent',
          'focus:bg-background focus:border-border',
          'placeholder:text-muted-foreground/60'
        )}
      />
      {localValue && (
        <button
          type="button"
          onClick={handleClear}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-muted-foreground hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  )
}
