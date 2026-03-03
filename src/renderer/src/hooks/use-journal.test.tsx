/**
 * useJournal Hook Tests (T494-T496)
 *
 * Tests for journal hooks: useJournalEntry, useJournalHeatmap, useMonthEntries
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import {
  useJournalEntry,
  useJournalHeatmap,
  useMonthEntries,
  useYearStats,
  useDayContext
} from './use-journal'
import {
  createTestQueryClient,
  createMockJournalEntry,
  setupHookTestEnvironment,
  cleanupHookTestEnvironment
} from '@tests/utils/hook-test-wrapper'

// ============================================================================
// Test Setup
// ============================================================================

describe('useJournalEntry', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    vi.useFakeTimers()
    setupHookTestEnvironment()
    queryClient = createTestQueryClient()
  })

  afterEach(() => {
    queryClient.clear()
    cleanupHookTestEnvironment()
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )

  // ==========================================================================
  // T494: useJournalEntry - load and manage entry
  // ==========================================================================

  describe('T494: load and manage entry', () => {
    it('should load journal entry for a date', async () => {
      const mockEntry = createMockJournalEntry({ date: '2026-01-03', content: 'Test entry' })

      ;(window.api.journal.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockEntry)

      const { result } = renderHook(() => useJournalEntry('2026-01-03'), { wrapper })

      expect(result.current.isLoading).toBe(true)

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(result.current.entry).toEqual(mockEntry)
      expect(result.current.error).toBeNull()
      expect(result.current.loadedForDate).toBe('2026-01-03')
    })

    it('should return null for non-existent entry', async () => {
      ;(window.api.journal.get as ReturnType<typeof vi.fn>).mockResolvedValue(null)

      const { result } = renderHook(() => useJournalEntry('2026-01-03'), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(result.current.entry).toBeNull()
      expect(result.current.loadedForDate).toBe('2026-01-03')
    })

    it('should handle load errors', async () => {
      ;(window.api.journal.get as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Failed to load journal')
      )

      const { result } = renderHook(() => useJournalEntry('2026-01-03'), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(result.current.error).toBe('Failed to load journal')
    })
  })

  // ==========================================================================
  // T495: useJournalEntry - auto-save with debouncing
  // ==========================================================================

  describe('T495: auto-save with debouncing', () => {
    it('should update content with debounced save', async () => {
      const mockEntry = createMockJournalEntry({ date: '2026-01-03' })
      const updatedEntry = { ...mockEntry, content: 'Updated content' }

      ;(window.api.journal.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockEntry)
      ;(window.api.journal.update as ReturnType<typeof vi.fn>).mockResolvedValue(updatedEntry)

      const { result } = renderHook(() => useJournalEntry('2026-01-03'), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      act(() => {
        result.current.updateContent('Updated content')
      })

      expect(result.current.isDirty).toBe(true)

      // Advance past debounce delay (1 second)
      await act(async () => {
        vi.advanceTimersByTime(1100)
      })

      await waitFor(() => {
        expect(result.current.isSaving).toBe(false)
      })

      expect(window.api.journal.update).toHaveBeenCalledWith(
        expect.objectContaining({
          date: '2026-01-03',
          content: 'Updated content'
        })
      )
    })

    it('should update tags with debounced save', async () => {
      const mockEntry = createMockJournalEntry({ date: '2026-01-03' })
      const updatedEntry = { ...mockEntry, tags: ['new-tag'] }

      ;(window.api.journal.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockEntry)
      ;(window.api.journal.update as ReturnType<typeof vi.fn>).mockResolvedValue(updatedEntry)

      const { result } = renderHook(() => useJournalEntry('2026-01-03'), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      act(() => {
        result.current.updateTags(['new-tag'])
      })

      expect(result.current.isDirty).toBe(true)

      await act(async () => {
        vi.advanceTimersByTime(1100)
      })

      await waitFor(() => {
        expect(result.current.isSaving).toBe(false)
      })

      expect(window.api.journal.update).toHaveBeenCalledWith(
        expect.objectContaining({
          date: '2026-01-03',
          tags: ['new-tag']
        })
      )
    })

    it('should allow immediate save with saveNow', async () => {
      const mockEntry = createMockJournalEntry({ date: '2026-01-03' })
      const updatedEntry = { ...mockEntry, content: 'Immediate save' }

      ;(window.api.journal.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockEntry)
      ;(window.api.journal.update as ReturnType<typeof vi.fn>).mockResolvedValue(updatedEntry)

      const { result } = renderHook(() => useJournalEntry('2026-01-03'), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      act(() => {
        result.current.updateContent('Immediate save')
      })

      await act(async () => {
        await result.current.saveNow()
      })

      expect(window.api.journal.update).toHaveBeenCalled()
    })

    it('should handle save errors with saveError state', async () => {
      const mockEntry = createMockJournalEntry({ date: '2026-01-03' })

      ;(window.api.journal.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockEntry)
      ;(window.api.journal.update as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Disk full')
      )

      const { result } = renderHook(() => useJournalEntry('2026-01-03'), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      act(() => {
        result.current.updateContent('Will fail')
      })

      await act(async () => {
        vi.advanceTimersByTime(1100)
      })

      await waitFor(() => {
        expect(result.current.isSaving).toBe(false)
      })

      expect(result.current.saveError).toBeTruthy()
      expect(result.current.isDirty).toBe(true) // Still dirty because save failed
    })

    it('should dismiss save error', async () => {
      const mockEntry = createMockJournalEntry({ date: '2026-01-03' })

      ;(window.api.journal.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockEntry)
      ;(window.api.journal.update as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Error'))

      const { result } = renderHook(() => useJournalEntry('2026-01-03'), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      act(() => {
        result.current.updateContent('Will fail')
      })

      await act(async () => {
        vi.advanceTimersByTime(1100)
      })

      await waitFor(() => {
        expect(result.current.saveError).toBeTruthy()
      })

      act(() => {
        result.current.dismissSaveError()
      })

      expect(result.current.saveError).toBeNull()
    })
  })

  // ==========================================================================
  // T496: useJournalEntry - delete and reload
  // ==========================================================================

  describe('T496: delete and reload', () => {
    it('should delete a journal entry', async () => {
      const mockEntry = createMockJournalEntry({ date: '2026-01-03' })

      ;(window.api.journal.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockEntry)
      ;(window.api.journal.delete as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true })

      const { result } = renderHook(() => useJournalEntry('2026-01-03'), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      let deleted = false
      await act(async () => {
        deleted = await result.current.deleteEntry()
      })

      expect(deleted).toBe(true)
      expect(window.api.journal.delete).toHaveBeenCalledWith('2026-01-03')
    })

    it('should reload entry from server', async () => {
      const mockEntry = createMockJournalEntry({ date: '2026-01-03' })

      ;(window.api.journal.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockEntry)

      const { result } = renderHook(() => useJournalEntry('2026-01-03'), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      const getCallsForDate = () =>
        (window.api.journal.get as ReturnType<typeof vi.fn>).mock.calls.filter(
          ([callDate]) => callDate === '2026-01-03'
        ).length

      expect(getCallsForDate()).toBe(1)

      await act(async () => {
        await result.current.reload()
      })

      expect(getCallsForDate()).toBe(2)
    })

    it('should force reload discarding pending changes', async () => {
      const mockEntry = createMockJournalEntry({ date: '2026-01-03' })

      ;(window.api.journal.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockEntry)

      const { result } = renderHook(() => useJournalEntry('2026-01-03'), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      act(() => {
        result.current.updateContent('Pending changes')
      })

      expect(result.current.isDirty).toBe(true)

      await act(async () => {
        await result.current.forceReload()
      })

      expect(result.current.isDirty).toBe(false)
    })
  })
})

// ============================================================================
// useJournalHeatmap Tests
// ============================================================================

describe('useJournalHeatmap', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    setupHookTestEnvironment()
    queryClient = createTestQueryClient()
  })

  afterEach(() => {
    queryClient.clear()
    cleanupHookTestEnvironment()
    vi.clearAllMocks()
  })

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )

  it('should load heatmap data for a year', async () => {
    const mockHeatmap = [
      { date: '2026-01-01', activityLevel: 2 },
      { date: '2026-01-02', activityLevel: 3 },
      { date: '2026-01-03', activityLevel: 1 }
    ]

    ;(window.api.journal.getHeatmap as ReturnType<typeof vi.fn>).mockResolvedValue(mockHeatmap)

    const { result } = renderHook(() => useJournalHeatmap(2026), { wrapper })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.data).toEqual(mockHeatmap)
    expect(window.api.journal.getHeatmap).toHaveBeenCalledWith(2026)
  })

  it('should handle heatmap load errors', async () => {
    ;(window.api.journal.getHeatmap as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Failed to load heatmap')
    )

    const { result } = renderHook(() => useJournalHeatmap(2026), { wrapper })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.error).toBe('Failed to load heatmap')
    expect(result.current.data).toEqual([])
  })

  it('should reload heatmap data', async () => {
    ;(window.api.journal.getHeatmap as ReturnType<typeof vi.fn>).mockResolvedValue([])

    const { result } = renderHook(() => useJournalHeatmap(2026), { wrapper })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(window.api.journal.getHeatmap).toHaveBeenCalledTimes(1)

    await act(async () => {
      await result.current.reload()
    })

    expect(window.api.journal.getHeatmap).toHaveBeenCalledTimes(2)
  })
})

// ============================================================================
// useMonthEntries Tests
// ============================================================================

describe('useMonthEntries', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    setupHookTestEnvironment()
    queryClient = createTestQueryClient()
  })

  afterEach(() => {
    queryClient.clear()
    cleanupHookTestEnvironment()
    vi.clearAllMocks()
  })

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )

  it('should load month entries', async () => {
    const mockEntries = [
      { date: '2026-01-01', preview: 'Entry 1 preview...', wordCount: 100 },
      { date: '2026-01-15', preview: 'Entry 2 preview...', wordCount: 200 }
    ]

    ;(window.api.journal.getMonth as ReturnType<typeof vi.fn>).mockResolvedValue(mockEntries)

    const { result } = renderHook(() => useMonthEntries(2026, 1), { wrapper })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.data).toEqual(mockEntries)
    expect(window.api.journal.getMonth).toHaveBeenCalledWith(2026, 1)
  })

  it('should handle month entries load errors', async () => {
    ;(window.api.journal.getMonth as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Failed to load month')
    )

    const { result } = renderHook(() => useMonthEntries(2026, 1), { wrapper })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.error).toBe('Failed to load month')
  })
})

// ============================================================================
// useYearStats Tests
// ============================================================================

describe('useYearStats', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    setupHookTestEnvironment()
    queryClient = createTestQueryClient()
  })

  afterEach(() => {
    queryClient.clear()
    cleanupHookTestEnvironment()
    vi.clearAllMocks()
  })

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )

  it('should load year stats', async () => {
    const mockStats = [
      { month: 1, entryCount: 15, wordCount: 5000 },
      { month: 2, entryCount: 20, wordCount: 7500 }
    ]

    ;(window.api.journal.getYearStats as ReturnType<typeof vi.fn>).mockResolvedValue(mockStats)

    const { result } = renderHook(() => useYearStats(2026), { wrapper })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.data).toEqual(mockStats)
    expect(window.api.journal.getYearStats).toHaveBeenCalledWith(2026)
  })
})

// ============================================================================
// useDayContext Tests
// ============================================================================

describe('useDayContext', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    setupHookTestEnvironment()
    queryClient = createTestQueryClient()
  })

  afterEach(() => {
    queryClient.clear()
    cleanupHookTestEnvironment()
    vi.clearAllMocks()
  })

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )

  it('should load day context with tasks', async () => {
    const mockContext = {
      tasks: [{ id: 'task-1', title: 'Task 1', dueDate: '2026-01-03' }],
      events: [],
      overdueCount: 2
    }

    ;(window.api.journal.getDayContext as ReturnType<typeof vi.fn>).mockResolvedValue(mockContext)

    const { result } = renderHook(() => useDayContext('2026-01-03'), { wrapper })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.data).toEqual(mockContext)
    expect(result.current.tasks).toEqual(mockContext.tasks)
    expect(result.current.overdueCount).toBe(2)
    expect(window.api.journal.getDayContext).toHaveBeenCalledWith('2026-01-03')
  })

  it('should return default values when no context', async () => {
    ;(window.api.journal.getDayContext as ReturnType<typeof vi.fn>).mockResolvedValue(null)

    const { result } = renderHook(() => useDayContext('2026-01-03'), { wrapper })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.tasks).toEqual([])
    expect(result.current.events).toEqual([])
    expect(result.current.overdueCount).toBe(0)
  })
})
