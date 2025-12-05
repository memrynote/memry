import { useState, useEffect, useMemo, useCallback } from "react"

import type { Task } from "@/data/sample-tasks"
import type {
  TaskFilters,
  TaskSort,
  SavedFilter,
  Project,
} from "@/data/tasks-data"
import {
  defaultFilters,
  defaultSort,
} from "@/data/tasks-data"
import { applyFiltersAndSort, hasActiveFilters } from "@/lib/task-utils"

// ============================================================================
// DEBOUNCE HOOK
// ============================================================================

/**
 * Hook to debounce a value
 */
export const useDebouncedValue = <T>(value: T, delay: number): T => {
  const [debouncedValue, setDebouncedValue] = useState<T>(value)

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedValue(value)
    }, delay)

    return () => {
      clearTimeout(timer)
    }
  }, [value, delay])

  return debouncedValue
}

// ============================================================================
// PERSISTENCE HELPERS
// ============================================================================

const FILTERS_STORAGE_KEY = "taskFilters"
const SAVED_FILTERS_KEY = "savedTaskFilters"

interface PersistedFilterState {
  filters: TaskFilters
  sort: TaskSort
  lastUpdated: string
}

/**
 * Generate a unique key for storing filters per view
 */
const getViewKey = (
  selectedType: string,
  selectedId: string,
  activeView: string
): string => {
  return `${selectedType}-${selectedId}-${activeView}`
}

/**
 * Save filters to localStorage
 */
const persistFilters = (
  viewKey: string,
  filters: TaskFilters,
  sort: TaskSort
): void => {
  try {
    const stored = JSON.parse(localStorage.getItem(FILTERS_STORAGE_KEY) || "{}")
    stored[viewKey] = {
      filters,
      sort,
      lastUpdated: new Date().toISOString(),
    }
    localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(stored))
  } catch (err) {
    console.error("Failed to persist filters:", err)
  }
}

/**
 * Load persisted filters from localStorage
 */
const loadPersistedFilters = (
  viewKey: string
): PersistedFilterState | null => {
  try {
    const stored = JSON.parse(localStorage.getItem(FILTERS_STORAGE_KEY) || "{}")
    return stored[viewKey] || null
  } catch (err) {
    console.error("Failed to load persisted filters:", err)
    return null
  }
}

/**
 * Save saved filters to localStorage
 */
const persistSavedFilters = (savedFilters: SavedFilter[]): void => {
  try {
    localStorage.setItem(SAVED_FILTERS_KEY, JSON.stringify(savedFilters))
  } catch (err) {
    console.error("Failed to persist saved filters:", err)
  }
}

/**
 * Load saved filters from localStorage
 */
const loadSavedFilters = (): SavedFilter[] => {
  try {
    const stored = localStorage.getItem(SAVED_FILTERS_KEY)
    if (!stored) return []
    const parsed = JSON.parse(stored)
    // Convert date strings back to Date objects
    return parsed.map((f: SavedFilter) => ({
      ...f,
      createdAt: new Date(f.createdAt),
    }))
  } catch (err) {
    console.error("Failed to load saved filters:", err)
    return []
  }
}

// ============================================================================
// MAIN FILTER STATE HOOK
// ============================================================================

interface UseFilterStateOptions {
  selectedType: string
  selectedId: string
  activeView: string
  persistFilters?: boolean
}

interface UseFilterStateReturn {
  filters: TaskFilters
  sort: TaskSort
  updateFilters: (updates: Partial<TaskFilters>) => void
  updateSort: (sort: TaskSort) => void
  clearFilters: () => void
  hasActiveFilters: boolean
}

/**
 * Hook to manage filter state with optional persistence
 */
export const useFilterState = ({
  selectedType,
  selectedId,
  activeView,
  persistFilters: shouldPersist = true,
}: UseFilterStateOptions): UseFilterStateReturn => {
  const viewKey = getViewKey(selectedType, selectedId, activeView)

  // Initialize filters from persisted state or defaults
  const [filters, setFilters] = useState<TaskFilters>(() => {
    if (!shouldPersist) return defaultFilters
    const persisted = loadPersistedFilters(viewKey)
    return persisted?.filters || defaultFilters
  })

  // Initialize sort from persisted state or defaults
  const [sort, setSort] = useState<TaskSort>(() => {
    if (!shouldPersist) return defaultSort
    const persisted = loadPersistedFilters(viewKey)
    return persisted?.sort || defaultSort
  })

  // Persist filters when they change
  useEffect(() => {
    if (shouldPersist) {
      persistFilters(viewKey, filters, sort)
    }
  }, [viewKey, filters, sort, shouldPersist])

  // Reset filters when view changes
  useEffect(() => {
    if (shouldPersist) {
      const persisted = loadPersistedFilters(viewKey)
      setFilters(persisted?.filters || defaultFilters)
      setSort(persisted?.sort || defaultSort)
    }
  }, [viewKey, shouldPersist])

  const updateFilters = useCallback((updates: Partial<TaskFilters>) => {
    setFilters((prev) => ({ ...prev, ...updates }))
  }, [])

  const updateSort = useCallback((newSort: TaskSort) => {
    setSort(newSort)
  }, [])

  const clearFilters = useCallback(() => {
    setFilters(defaultFilters)
  }, [])

  const isActive = useMemo(() => hasActiveFilters(filters), [filters])

  return {
    filters,
    sort,
    updateFilters,
    updateSort,
    clearFilters,
    hasActiveFilters: isActive,
  }
}

// ============================================================================
// FILTERED TASKS HOOK
// ============================================================================

interface UseFilteredTasksOptions {
  tasks: Task[]
  filters: TaskFilters
  sort: TaskSort
  projects: Project[]
  searchDebounceMs?: number
}

interface UseFilteredTasksReturn {
  filteredTasks: Task[]
  totalCount: number
  filteredCount: number
}

/**
 * Hook to apply filters and sort to tasks with memoization
 */
export const useFilteredAndSortedTasks = ({
  tasks,
  filters,
  sort,
  projects,
  searchDebounceMs = 150,
}: UseFilteredTasksOptions): UseFilteredTasksReturn => {
  // Debounce search query
  const debouncedSearch = useDebouncedValue(filters.search, searchDebounceMs)

  // Create filters with debounced search
  const filtersWithDebouncedSearch = useMemo(
    () => ({ ...filters, search: debouncedSearch }),
    [filters, debouncedSearch]
  )

  // Apply filters and sort
  const filteredTasks = useMemo(
    () => applyFiltersAndSort(tasks, filtersWithDebouncedSearch, sort, projects),
    [tasks, filtersWithDebouncedSearch, sort, projects]
  )

  return {
    filteredTasks,
    totalCount: tasks.length,
    filteredCount: filteredTasks.length,
  }
}

// ============================================================================
// SAVED FILTERS HOOK
// ============================================================================

interface UseSavedFiltersReturn {
  savedFilters: SavedFilter[]
  saveFilter: (name: string, filters: TaskFilters, sort?: TaskSort) => void
  deleteFilter: (id: string) => void
  updateFilter: (id: string, updates: Partial<SavedFilter>) => void
}

/**
 * Hook to manage saved filter combinations
 */
export const useSavedFilters = (): UseSavedFiltersReturn => {
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>(() => loadSavedFilters())

  // Persist when saved filters change
  useEffect(() => {
    persistSavedFilters(savedFilters)
  }, [savedFilters])

  const saveFilter = useCallback(
    (name: string, filters: TaskFilters, sort?: TaskSort) => {
      const newFilter: SavedFilter = {
        id: `filter-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
        name,
        filters,
        sort,
        createdAt: new Date(),
      }
      setSavedFilters((prev) => [...prev, newFilter])
    },
    []
  )

  const deleteFilter = useCallback((id: string) => {
    setSavedFilters((prev) => prev.filter((f) => f.id !== id))
  }, [])

  const updateFilter = useCallback((id: string, updates: Partial<SavedFilter>) => {
    setSavedFilters((prev) =>
      prev.map((f) => (f.id === id ? { ...f, ...updates } : f))
    )
  }, [])

  return {
    savedFilters,
    saveFilter,
    deleteFilter,
    updateFilter,
  }
}
