import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { createLogger } from '@/lib/logger'

import type { Task, Priority } from '@/data/sample-tasks'

const log = createLogger('Hook:TaskFilters')
import type { TaskFilters, TaskSort, SavedFilter, Project, DueDateFilter } from '@/data/tasks-data'
import { defaultFilters, defaultSort } from '@/data/tasks-data'
import { applyFiltersAndSort, hasActiveFilters } from '@/lib/task-utils'
import {
  savedFiltersService,
  onSavedFilterCreated,
  onSavedFilterUpdated,
  onSavedFilterDeleted,
  type SavedFilter as DbSavedFilter,
  type SavedFilterConfig
} from '@/services/saved-filters-service'

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

const getDefaultSortForView = (activeView: string): TaskSort =>
  activeView === 'kanban' ? { field: 'status', direction: 'asc' } : defaultSort

const FILTERS_STORAGE_KEY = 'taskFilters'
const SORT_STORAGE_KEY = 'taskSortPrefs'
const SAVED_FILTERS_KEY = 'savedTaskFilters'

interface PersistedFilterState {
  filters: TaskFilters
  lastUpdated: string
}

interface PersistedSortState {
  sort: TaskSort
  lastUpdated: string
}

const getFilterKey = (selectedType: string, selectedId: string): string =>
  `${selectedType}-${selectedId}`

const getSortKey = (selectedType: string, selectedId: string, activeView: string): string =>
  `${selectedType}-${selectedId}-${activeView}`

const persistFilterState = (filterKey: string, filters: TaskFilters): void => {
  try {
    const stored = JSON.parse(localStorage.getItem(FILTERS_STORAGE_KEY) || '{}')
    stored[filterKey] = { filters, lastUpdated: new Date().toISOString() }
    localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(stored))
  } catch (err) {
    log.error('Failed to persist filters:', err)
  }
}

const persistSortState = (sortKey: string, sort: TaskSort): void => {
  try {
    const stored = JSON.parse(localStorage.getItem(SORT_STORAGE_KEY) || '{}')
    stored[sortKey] = { sort, lastUpdated: new Date().toISOString() }
    localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(stored))
  } catch (err) {
    log.error('Failed to persist sort:', err)
  }
}

const loadPersistedFilterState = (filterKey: string): PersistedFilterState | null => {
  try {
    const stored = JSON.parse(localStorage.getItem(FILTERS_STORAGE_KEY) || '{}')
    return stored[filterKey] || null
  } catch (err) {
    log.error('Failed to load persisted filters:', err)
    return null
  }
}

const loadPersistedSortState = (sortKey: string): PersistedSortState | null => {
  try {
    const stored = JSON.parse(localStorage.getItem(SORT_STORAGE_KEY) || '{}')
    return stored[sortKey] || null
  } catch (err) {
    log.error('Failed to load persisted sort:', err)
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
      createdAt: new Date(f.createdAt)
    }))
  } catch (err) {
    log.error('Failed to load saved filters:', err)
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
  persistFilters: shouldPersist = true
}: UseFilterStateOptions): UseFilterStateReturn => {
  const filterKey = getFilterKey(selectedType, selectedId)
  const sortKey = getSortKey(selectedType, selectedId, activeView)

  const isSwitchingFilterRef = useRef(false)
  const isSwitchingSortRef = useRef(false)
  const previousFilterKeyRef = useRef(filterKey)
  const previousSortKeyRef = useRef(sortKey)

  const [filters, setFilters] = useState<TaskFilters>(() => {
    if (!shouldPersist) return defaultFilters
    const persisted = loadPersistedFilterState(filterKey)
    return persisted?.filters || defaultFilters
  })

  const [sort, setSort] = useState<TaskSort>(() => {
    if (!shouldPersist) return getDefaultSortForView(activeView)
    const persisted = loadPersistedSortState(sortKey)
    return persisted?.sort || getDefaultSortForView(activeView)
  })

  // Reload filters when project changes (filterKey does NOT include activeView)
  useEffect(() => {
    if (!shouldPersist) return
    if (previousFilterKeyRef.current === filterKey) return

    const persisted = loadPersistedFilterState(filterKey)
    isSwitchingFilterRef.current = true
    previousFilterKeyRef.current = filterKey
    setFilters(persisted?.filters || defaultFilters)
  }, [filterKey, shouldPersist])

  // Reload sort when project OR view changes (sortKey includes activeView)
  useEffect(() => {
    if (!shouldPersist) return
    if (previousSortKeyRef.current === sortKey) return

    const persisted = loadPersistedSortState(sortKey)
    isSwitchingSortRef.current = true
    previousSortKeyRef.current = sortKey
    setSort(persisted?.sort || getDefaultSortForView(activeView))
  }, [sortKey, shouldPersist, activeView])

  // Persist filters when they change
  useEffect(() => {
    if (!shouldPersist) return
    if (isSwitchingFilterRef.current) {
      isSwitchingFilterRef.current = false
      return
    }
    persistFilterState(filterKey, filters)
  }, [filterKey, filters, shouldPersist])

  // Persist sort when it changes
  useEffect(() => {
    if (!shouldPersist) return
    if (isSwitchingSortRef.current) {
      isSwitchingSortRef.current = false
      return
    }
    persistSortState(sortKey, sort)
  }, [sortKey, sort, shouldPersist])

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
    hasActiveFilters: isActive
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
  searchDebounceMs = 150
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
    filteredCount: filteredTasks.length
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
  toggleStar: (id: string) => void
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
    customEnd: config.filters.dueDate.customEnd ? new Date(config.filters.dueDate.customEnd) : null
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
      hasTime: config.filters.hasTime
    },
    sort: config.sort
      ? {
          field: config.sort.field,
          direction: config.sort.direction
        }
      : undefined,
    starred: config.starred ?? false,
    createdAt: new Date(dbFilter.createdAt)
  }
}

/**
 * Convert frontend filter to DB format
 */
function frontendToDbConfig(
  filters: TaskFilters,
  sort?: TaskSort,
  starred?: boolean
): SavedFilterConfig {
  return {
    filters: {
      search: filters.search,
      projectIds: filters.projectIds,
      priorities: filters.priorities,
      dueDate: {
        type: filters.dueDate.type,
        customStart: filters.dueDate.customStart?.toISOString() ?? null,
        customEnd: filters.dueDate.customEnd?.toISOString() ?? null
      },
      statusIds: filters.statusIds,
      completion: filters.completion,
      repeatType: filters.repeatType,
      hasTime: filters.hasTime
    },
    sort: sort
      ? {
          field: sort.field,
          direction: sort.direction
        }
      : undefined,
    starred
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
        log.error('Failed to load saved filters from DB:', error)
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
      setSavedFilters((prev) => prev.map((f) => (f.id === event.id ? frontendFilter : f)))
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

  const saveFilter = useCallback(async (name: string, filters: TaskFilters, sort?: TaskSort) => {
    try {
      const config = frontendToDbConfig(filters, sort)
      await savedFiltersService.create({ name, config })
      // Event subscription will update state
    } catch (error) {
      log.error('Failed to save filter:', error)
    }
  }, [])

  const deleteFilter = useCallback(async (id: string) => {
    try {
      await savedFiltersService.delete(id)
      // Event subscription will update state
    } catch (error) {
      log.error('Failed to delete filter:', error)
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
        log.error('Failed to update filter:', error)
      }
    },
    [savedFilters]
  )

  const toggleStar = useCallback(
    async (id: string) => {
      const current = savedFilters.find((f) => f.id === id)
      if (!current) return

      const newStarred = !current.starred

      setSavedFilters((prev) => prev.map((f) => (f.id === id ? { ...f, starred: newStarred } : f)))

      try {
        const config = frontendToDbConfig(current.filters, current.sort, newStarred)
        await savedFiltersService.update({ id, config })
      } catch (error) {
        log.error('Failed to toggle star:', error)
        setSavedFilters((prev) =>
          prev.map((f) => (f.id === id ? { ...f, starred: current.starred } : f))
        )
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
    toggleStar
  }
}
