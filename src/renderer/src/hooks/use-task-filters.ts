import { useState, useEffect, useMemo, useCallback } from "react"

import type { Task, Priority } from "@/data/sample-tasks"
import type {
  TaskFilters,
  TaskSort,
  SavedFilter,
  Project,
  DueDateFilter,
} from "@/data/tasks-data"
import {
  defaultFilters,
  defaultSort,
} from "@/data/tasks-data"
import { applyFiltersAndSort, hasActiveFilters } from "@/lib/task-utils"
import {
  savedFiltersService,
  onSavedFilterCreated,
  onSavedFilterUpdated,
  onSavedFilterDeleted,
  type SavedFilter as DbSavedFilter,
  type SavedFilterConfig,
} from "@/services/saved-filters-service"

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
 * Load saved filters from localStorage (fallback for backwards compatibility)
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
  isLoading: boolean
  saveFilter: (name: string, filters: TaskFilters, sort?: TaskSort) => void
  deleteFilter: (id: string) => void
  updateFilter: (id: string, updates: Partial<SavedFilter>) => void
}

/**
 * Convert DB saved filter to frontend format
 */
function dbToFrontendFilter(dbFilter: DbSavedFilter): SavedFilter {
  const config = dbFilter.config

  // Convert DueDateFilter dates from string to Date if custom
  const dueDate: DueDateFilter = {
    type: config.filters.dueDate.type,
    customStart: config.filters.dueDate.customStart
      ? new Date(config.filters.dueDate.customStart)
      : null,
    customEnd: config.filters.dueDate.customEnd
      ? new Date(config.filters.dueDate.customEnd)
      : null,
  }

  return {
    id: dbFilter.id,
    name: dbFilter.name,
    filters: {
      search: config.filters.search,
      projectIds: config.filters.projectIds,
      priorities: config.filters.priorities as Priority[],
      dueDate,
      statusIds: config.filters.statusIds,
      completion: config.filters.completion,
      repeatType: config.filters.repeatType,
      hasTime: config.filters.hasTime,
    },
    sort: config.sort
      ? {
          field: config.sort.field,
          direction: config.sort.direction,
        }
      : undefined,
    createdAt: new Date(dbFilter.createdAt),
  }
}

/**
 * Convert frontend filter to DB format
 */
function frontendToDbConfig(filters: TaskFilters, sort?: TaskSort): SavedFilterConfig {
  return {
    filters: {
      search: filters.search,
      projectIds: filters.projectIds,
      priorities: filters.priorities,
      dueDate: {
        type: filters.dueDate.type,
        customStart: filters.dueDate.customStart?.toISOString() ?? null,
        customEnd: filters.dueDate.customEnd?.toISOString() ?? null,
      },
      statusIds: filters.statusIds,
      completion: filters.completion,
      repeatType: filters.repeatType,
      hasTime: filters.hasTime,
    },
    sort: sort
      ? {
          field: sort.field,
          direction: sort.direction,
        }
      : undefined,
  }
}

/**
 * Hook to manage saved filter combinations
 * Uses database storage via savedFiltersService
 */
export const useSavedFilters = (): UseSavedFiltersReturn => {
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>([])
  const [isLoading, setIsLoading] = useState(true)

  // Load saved filters from database on mount
  useEffect(() => {
    const loadFilters = async (): Promise<void> => {
      try {
        const response = await savedFiltersService.list()
        setSavedFilters(response.savedFilters.map(dbToFrontendFilter))
      } catch (error) {
        console.error("[useSavedFilters] Failed to load saved filters:", error)
        // Fallback to localStorage for backwards compatibility
        setSavedFilters(loadSavedFilters())
      } finally {
        setIsLoading(false)
      }
    }
    loadFilters()
  }, [])

  // Subscribe to saved filter events
  useEffect(() => {
    const unsubCreated = onSavedFilterCreated((event) => {
      const frontendFilter = dbToFrontendFilter(event.savedFilter)
      setSavedFilters((prev) => [...prev, frontendFilter])
    })

    const unsubUpdated = onSavedFilterUpdated((event) => {
      const frontendFilter = dbToFrontendFilter(event.savedFilter)
      setSavedFilters((prev) =>
        prev.map((f) => (f.id === event.id ? frontendFilter : f))
      )
    })

    const unsubDeleted = onSavedFilterDeleted((event) => {
      setSavedFilters((prev) => prev.filter((f) => f.id !== event.id))
    })

    return () => {
      unsubCreated()
      unsubUpdated()
      unsubDeleted()
    }
  }, [])

  const saveFilter = useCallback(
    async (name: string, filters: TaskFilters, sort?: TaskSort) => {
      try {
        const config = frontendToDbConfig(filters, sort)
        await savedFiltersService.create({ name, config })
        // Event subscription will update state
      } catch (error) {
        console.error("[useSavedFilters] Failed to save filter:", error)
      }
    },
    []
  )

  const deleteFilter = useCallback(async (id: string) => {
    try {
      await savedFiltersService.delete(id)
      // Event subscription will update state
    } catch (error) {
      console.error("[useSavedFilters] Failed to delete filter:", error)
    }
  }, [])

  const updateFilter = useCallback(
    async (id: string, updates: Partial<SavedFilter>) => {
      try {
        const updateInput: { id: string; name?: string; config?: SavedFilterConfig } = { id }
        if (updates.name) updateInput.name = updates.name
        if (updates.filters || updates.sort) {
          // Get current filter to merge updates
          const current = savedFilters.find((f) => f.id === id)
          if (current) {
            updateInput.config = frontendToDbConfig(
              updates.filters ?? current.filters,
              updates.sort ?? current.sort
            )
          }
        }
        await savedFiltersService.update(updateInput)
        // Event subscription will update state
      } catch (error) {
        console.error("[useSavedFilters] Failed to update filter:", error)
      }
    },
    [savedFilters]
  )

  return {
    savedFilters,
    isLoading,
    saveFilter,
    deleteFilter,
    updateFilter,
  }
}
