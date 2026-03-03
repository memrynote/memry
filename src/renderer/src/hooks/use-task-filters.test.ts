/**
 * useTaskFilters Hook Tests (T687)
 * Tests for filter state management, persistence, and task filtering.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import {
  useFilterState,
  useFilteredAndSortedTasks,
  useSavedFilters,
  useDebouncedValue
} from './use-task-filters'
import { defaultFilters, defaultSort } from '@/data/tasks-data'
import type { Task, Priority } from '@/data/sample-tasks'
import type { Project, TaskFilters, TaskSort } from '@/data/tasks-data'

// ============================================================================
// Mocks
// ============================================================================

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key]
    }),
    clear: vi.fn(() => {
      store = {}
    }),
    get store() {
      return store
    }
  }
})()

Object.defineProperty(window, 'localStorage', {
  value: localStorageMock
})

// Mock savedFiltersService
vi.mock('@/services/saved-filters-service', () => ({
  savedFiltersService: {
    list: vi.fn().mockResolvedValue({ savedFilters: [], total: 0, hasMore: false }),
    create: vi.fn().mockResolvedValue({ success: true }),
    update: vi.fn().mockResolvedValue({ success: true }),
    delete: vi.fn().mockResolvedValue({ success: true })
  },
  onSavedFilterCreated: vi.fn(() => () => {}),
  onSavedFilterUpdated: vi.fn(() => () => {}),
  onSavedFilterDeleted: vi.fn(() => () => {})
}))

// Mock applyFiltersAndSort
vi.mock('@/lib/task-utils', () => ({
  applyFiltersAndSort: vi.fn((tasks: Task[]) => tasks),
  hasActiveFilters: vi.fn((filters: TaskFilters) => {
    return (
      filters.search !== '' ||
      filters.projectIds.length > 0 ||
      filters.priorities.length > 0 ||
      filters.statusIds.length > 0
    )
  })
}))

import { applyFiltersAndSort, hasActiveFilters } from '@/lib/task-utils'

// ============================================================================
// Test Data
// ============================================================================

const createMockTask = (overrides: Partial<Task> = {}): Task => ({
  id: `task-${Math.random().toString(36).slice(2)}`,
  title: 'Test Task',
  description: '',
  dueDate: null,
  dueTime: null,
  priority: 'none',
  projectId: 'project-1',
  statusId: 'status-1',
  position: 0,
  repeatConfig: null,
  completedAt: null,
  archivedAt: null,
  parentId: null,
  createdAt: new Date(),
  tags: [],
  linkedNoteIds: [],
  ...overrides
})

const createMockProject = (overrides: Partial<Project> = {}): Project => ({
  id: `project-${Math.random().toString(36).slice(2)}`,
  name: 'Test Project',
  icon: '📁',
  color: '#6366f1',
  position: 0,
  isArchived: false,
  statuses: [
    { id: 'status-1', name: 'To Do', color: '#gray', type: 'todo', isDefault: true, position: 0 },
    { id: 'status-2', name: 'Done', color: '#green', type: 'done', isDefault: false, position: 1 }
  ],
  ...overrides
})

// ============================================================================
// useDebouncedValue Tests
// ============================================================================

describe('useDebouncedValue', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('should return initial value immediately', () => {
    const { result } = renderHook(() => useDebouncedValue('initial', 300))

    expect(result.current).toBe('initial')
  })

  it('should debounce value updates', () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 300), {
      initialProps: { value: 'initial' }
    })

    expect(result.current).toBe('initial')

    // Update value
    rerender({ value: 'updated' })

    // Should still be initial before debounce
    expect(result.current).toBe('initial')

    // Advance timer
    act(() => {
      vi.advanceTimersByTime(300)
    })

    expect(result.current).toBe('updated')
  })

  it('should reset timer on rapid changes', () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 300), {
      initialProps: { value: 'v1' }
    })

    rerender({ value: 'v2' })
    act(() => vi.advanceTimersByTime(100))

    rerender({ value: 'v3' })
    act(() => vi.advanceTimersByTime(100))

    rerender({ value: 'v4' })

    // Still at initial after 200ms because timer keeps resetting
    expect(result.current).toBe('v1')

    // Complete the debounce
    act(() => vi.advanceTimersByTime(300))

    expect(result.current).toBe('v4')
  })
})

// ============================================================================
// useFilterState Tests
// ============================================================================

describe('useFilterState', () => {
  beforeEach(() => {
    localStorageMock.clear()
    vi.clearAllMocks()
  })

  const defaultOptions = {
    selectedType: 'project',
    selectedId: 'project-1',
    activeView: 'all'
  }

  describe('initial state', () => {
    it('should initialize with default filters', () => {
      const { result } = renderHook(() => useFilterState(defaultOptions))

      expect(result.current.filters).toEqual(defaultFilters)
      expect(result.current.sort).toEqual(defaultSort)
    })

    it('should load persisted filters on mount', () => {
      const viewKey = 'project-project-1-all'
      const persistedFilters = {
        ...defaultFilters,
        search: 'persisted search'
      }
      localStorageMock.setItem(
        'taskFilters',
        JSON.stringify({
          [viewKey]: {
            filters: persistedFilters,
            sort: defaultSort,
            lastUpdated: new Date().toISOString()
          }
        })
      )

      const { result } = renderHook(() => useFilterState(defaultOptions))

      expect(result.current.filters.search).toBe('persisted search')
    })

    it('should not load persisted filters when persistence is disabled', () => {
      const viewKey = 'project-project-1-all'
      localStorageMock.setItem(
        'taskFilters',
        JSON.stringify({
          [viewKey]: {
            filters: { ...defaultFilters, search: 'persisted' },
            sort: defaultSort
          }
        })
      )

      const { result } = renderHook(() =>
        useFilterState({ ...defaultOptions, persistFilters: false })
      )

      expect(result.current.filters.search).toBe('')
    })
  })

  describe('updateFilters', () => {
    it('should update specific filter property', () => {
      const { result } = renderHook(() => useFilterState(defaultOptions))

      act(() => {
        result.current.updateFilters({ search: 'test query' })
      })

      expect(result.current.filters.search).toBe('test query')
    })

    it('should preserve other filter properties', () => {
      const { result } = renderHook(() => useFilterState(defaultOptions))

      act(() => {
        result.current.updateFilters({ priorities: ['high'] })
        result.current.updateFilters({ search: 'test' })
      })

      expect(result.current.filters.priorities).toEqual(['high'])
      expect(result.current.filters.search).toBe('test')
    })

    it('should persist filters to localStorage', async () => {
      const { result } = renderHook(() => useFilterState(defaultOptions))

      act(() => {
        result.current.updateFilters({ search: 'persisted query' })
      })

      // Wait for effect to run
      await waitFor(() => {
        expect(localStorageMock.setItem).toHaveBeenCalled()
      })

      const stored = JSON.parse(localStorageMock.store['taskFilters'])
      expect(stored['project-project-1-all'].filters.search).toBe('persisted query')
    })
  })

  describe('updateSort', () => {
    it('should update sort configuration', () => {
      const { result } = renderHook(() => useFilterState(defaultOptions))

      const newSort: TaskSort = { field: 'priority', direction: 'desc' }
      act(() => {
        result.current.updateSort(newSort)
      })

      expect(result.current.sort).toEqual(newSort)
    })
  })

  describe('clearFilters', () => {
    it('should reset filters to defaults', () => {
      const { result } = renderHook(() => useFilterState(defaultOptions))

      // Set some filters
      act(() => {
        result.current.updateFilters({
          search: 'query',
          priorities: ['high', 'medium']
        })
      })

      expect(result.current.filters.search).toBe('query')

      // Clear filters
      act(() => {
        result.current.clearFilters()
      })

      expect(result.current.filters).toEqual(defaultFilters)
    })
  })

  describe('hasActiveFilters', () => {
    it('should be false with default filters', () => {
      const { result } = renderHook(() => useFilterState(defaultOptions))

      expect(result.current.hasActiveFilters).toBe(false)
    })

    it('should be true when search is set', () => {
      const { result } = renderHook(() => useFilterState(defaultOptions))

      act(() => {
        result.current.updateFilters({ search: 'query' })
      })

      expect(result.current.hasActiveFilters).toBe(true)
    })

    it('should be true when priorities are set', () => {
      const { result } = renderHook(() => useFilterState(defaultOptions))

      act(() => {
        result.current.updateFilters({ priorities: ['high'] })
      })

      expect(result.current.hasActiveFilters).toBe(true)
    })
  })

  describe('view key changes', () => {
    it('should reload filters when view changes', async () => {
      const viewKey1 = 'project-project-1-all'
      const viewKey2 = 'project-project-2-all'

      localStorageMock.setItem(
        'taskFilters',
        JSON.stringify({
          [viewKey1]: {
            filters: { ...defaultFilters, search: 'project-1-search' },
            sort: defaultSort
          },
          [viewKey2]: {
            filters: { ...defaultFilters, search: 'project-2-search' },
            sort: defaultSort
          }
        })
      )

      const { result, rerender } = renderHook((props) => useFilterState(props), {
        initialProps: { ...defaultOptions, selectedId: 'project-1' }
      })

      expect(result.current.filters.search).toBe('project-1-search')

      rerender({ ...defaultOptions, selectedId: 'project-2' })

      await waitFor(() => {
        expect(result.current.filters.search).toBe('project-2-search')
      })
    })
  })
})

// ============================================================================
// useFilteredAndSortedTasks Tests
// ============================================================================

describe('useFilteredAndSortedTasks', () => {
  const mockTasks = [
    createMockTask({ id: 'task-1', title: 'Task 1' }),
    createMockTask({ id: 'task-2', title: 'Task 2' }),
    createMockTask({ id: 'task-3', title: 'Task 3' })
  ]

  const mockProjects = [createMockProject({ id: 'project-1' })]

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    // Default mock returns all tasks
    vi.mocked(applyFiltersAndSort).mockImplementation((tasks) => tasks)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('should return all tasks with default filters', () => {
    const { result } = renderHook(() =>
      useFilteredAndSortedTasks({
        tasks: mockTasks,
        filters: defaultFilters,
        sort: defaultSort,
        projects: mockProjects
      })
    )

    expect(result.current.filteredTasks).toHaveLength(3)
    expect(result.current.totalCount).toBe(3)
    expect(result.current.filteredCount).toBe(3)
  })

  it('should debounce search filter', () => {
    const { rerender } = renderHook(
      ({ filters }) =>
        useFilteredAndSortedTasks({
          tasks: mockTasks,
          filters,
          sort: defaultSort,
          projects: mockProjects,
          searchDebounceMs: 150
        }),
      { initialProps: { filters: defaultFilters } }
    )

    expect(applyFiltersAndSort).toHaveBeenCalledWith(
      mockTasks,
      expect.objectContaining({ search: '' }),
      defaultSort,
      mockProjects
    )

    rerender({ filters: { ...defaultFilters, search: 'query' } })

    const callCountBeforeDebounce = vi.mocked(applyFiltersAndSort).mock.calls.length
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(vi.mocked(applyFiltersAndSort).mock.calls.length).toBe(callCountBeforeDebounce)

    act(() => {
      vi.advanceTimersByTime(100)
    })

    expect(applyFiltersAndSort).toHaveBeenCalledWith(
      mockTasks,
      expect.objectContaining({ search: 'query' }),
      defaultSort,
      mockProjects
    )
  })

  it('should update counts when tasks change', () => {
    vi.mocked(applyFiltersAndSort).mockImplementation((tasks) => tasks.slice(0, 2))

    const { result } = renderHook(() =>
      useFilteredAndSortedTasks({
        tasks: mockTasks,
        filters: { ...defaultFilters, search: 'filter' },
        sort: defaultSort,
        projects: mockProjects
      })
    )

    // Wait for debounce
    act(() => {
      vi.advanceTimersByTime(200)
    })

    expect(result.current.totalCount).toBe(3)
    expect(result.current.filteredCount).toBe(2)
  })

  it('should recompute when filters change', () => {
    const { rerender } = renderHook(
      ({ filters }) =>
        useFilteredAndSortedTasks({
          tasks: mockTasks,
          filters,
          sort: defaultSort,
          projects: mockProjects
        }),
      { initialProps: { filters: defaultFilters } }
    )

    const initialCallCount = vi.mocked(applyFiltersAndSort).mock.calls.length

    rerender({ filters: { ...defaultFilters, priorities: ['high'] } })

    expect(vi.mocked(applyFiltersAndSort).mock.calls.length).toBeGreaterThan(initialCallCount)
  })
})

// ============================================================================
// useSavedFilters Tests
// ============================================================================

describe('useSavedFilters', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorageMock.clear()
  })

  it('should load saved filters on mount', async () => {
    const { savedFiltersService } = await import('@/services/saved-filters-service')
    vi.mocked(savedFiltersService.list).mockResolvedValue({
      savedFilters: [
        {
          id: 'filter-1',
          name: 'My Filter',
          config: {
            filters: {
              search: 'test',
              projectIds: [],
              priorities: [],
              dueDate: { type: 'all', customStart: null, customEnd: null },
              statusIds: [],
              completion: 'all',
              repeatType: 'all',
              hasTime: 'all'
            }
          },
          createdAt: new Date().toISOString(),
          position: 0
        }
      ],
      total: 1,
      hasMore: false
    })

    const { result } = renderHook(() => useSavedFilters())

    expect(result.current.isLoading).toBe(true)

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.savedFilters).toHaveLength(1)
    expect(result.current.savedFilters[0].name).toBe('My Filter')
  })

  it('should handle load errors gracefully', async () => {
    const { savedFiltersService } = await import('@/services/saved-filters-service')
    vi.mocked(savedFiltersService.list).mockRejectedValue(new Error('Load failed'))

    const { result } = renderHook(() => useSavedFilters())

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    // Should fallback to empty array
    expect(result.current.savedFilters).toEqual([])
  })

  it('should save filter', async () => {
    const { savedFiltersService } = await import('@/services/saved-filters-service')

    const { result } = renderHook(() => useSavedFilters())

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    await act(async () => {
      result.current.saveFilter('New Filter', defaultFilters)
    })

    expect(savedFiltersService.create).toHaveBeenCalledWith({
      name: 'New Filter',
      config: expect.objectContaining({
        filters: expect.any(Object)
      })
    })
  })

  it('should delete filter', async () => {
    const { savedFiltersService } = await import('@/services/saved-filters-service')

    const { result } = renderHook(() => useSavedFilters())

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    await act(async () => {
      result.current.deleteFilter('filter-1')
    })

    expect(savedFiltersService.delete).toHaveBeenCalledWith('filter-1')
  })

  it('should update filter', async () => {
    const { savedFiltersService } = await import('@/services/saved-filters-service')
    vi.mocked(savedFiltersService.list).mockResolvedValue({
      savedFilters: [
        {
          id: 'filter-1',
          name: 'Old Name',
          config: {
            filters: {
              search: '',
              projectIds: [],
              priorities: [],
              dueDate: { type: 'all', customStart: null, customEnd: null },
              statusIds: [],
              completion: 'all',
              repeatType: 'all',
              hasTime: 'all'
            }
          },
          createdAt: new Date().toISOString(),
          position: 0
        }
      ],
      total: 1,
      hasMore: false
    })

    const { result } = renderHook(() => useSavedFilters())

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    await act(async () => {
      result.current.updateFilter('filter-1', { name: 'New Name' })
    })

    expect(savedFiltersService.update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'filter-1',
        name: 'New Name'
      })
    )
  })
})
