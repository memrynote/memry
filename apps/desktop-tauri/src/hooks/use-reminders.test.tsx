/**
 * useReminders Hook Tests (T507-T508)
 * Tests for reminder hooks: list, create, update, delete, snooze, and dismiss.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import {
  useReminders,
  useRemindersForTarget,
  useCreateReminder,
  useUpdateReminder,
  useDeleteReminder,
  useDismissReminder,
  useSnoozeReminder
} from './use-reminders'
import {
  createTestQueryClient,
  createMockReminder,
  setupHookTestEnvironment,
  cleanupHookTestEnvironment
} from '@tests/utils/hook-test-wrapper'

// ============================================================================
// Test Setup
// ============================================================================

describe('useReminders', () => {
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

  // ==========================================================================
  // T507: List Reminders
  // ==========================================================================

  describe('list reminders', () => {
    it('should load reminders on mount', async () => {
      const mockReminders = [
        createMockReminder({ id: 'rem-1', note: 'Reminder 1' }),
        createMockReminder({ id: 'rem-2', note: 'Reminder 2' })
      ]

      ;(window.api.reminders.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        reminders: mockReminders,
        total: 2,
        hasMore: false
      })

      const { result } = renderHook(() => useReminders(), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(result.current.reminders).toHaveLength(2)
      expect(result.current.total).toBe(2)
      expect(window.api.reminders.list).toHaveBeenCalled()
    })

    it('should load reminders with filters', async () => {
      ;(window.api.reminders.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        reminders: [],
        total: 0,
        hasMore: false
      })

      const { result } = renderHook(() => useReminders({ status: 'pending', limit: 10 }), {
        wrapper
      })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(window.api.reminders.list).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'pending',
          limit: 10
        })
      )
    })

    it('should handle loading errors gracefully', async () => {
      ;(window.api.reminders.list as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Failed to load reminders')
      )

      const { result } = renderHook(() => useReminders(), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(result.current.error).toBeTruthy()
      expect(result.current.reminders).toHaveLength(0)
    })
  })

  // ==========================================================================
  // Reminders for Target
  // ==========================================================================

  describe('reminders for target', () => {
    it('should load reminders for a specific note', async () => {
      const mockReminders = [createMockReminder({ id: 'rem-1', targetId: 'note-1' })]

      ;(window.api.reminders.getForTarget as ReturnType<typeof vi.fn>).mockResolvedValue(
        mockReminders
      )

      const { result } = renderHook(() => useRemindersForTarget('note', 'note-1'), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(result.current.reminders).toHaveLength(1)
      expect(result.current.hasReminders).toBe(true)
    })

    it('should not load when targetId is empty', async () => {
      const { result } = renderHook(() => useRemindersForTarget('note', ''), { wrapper })

      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(window.api.reminders.getForTarget).not.toHaveBeenCalled()
      expect(result.current.reminders).toEqual([])
    })
  })
})

// ============================================================================
// Create Reminder Tests
// ============================================================================

describe('useCreateReminder', () => {
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

  it('should create a reminder successfully', async () => {
    const newReminder = createMockReminder({ id: 'rem-new' })

    ;(window.api.reminders.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      reminder: newReminder
    })

    const { result } = renderHook(() => useCreateReminder(), { wrapper })

    await act(async () => {
      await result.current.mutateAsync({
        targetType: 'note',
        targetId: 'note-1',
        dueAt: '2026-01-10T10:00:00Z'
      })
    })

    expect(window.api.reminders.create).toHaveBeenCalledWith({
      targetType: 'note',
      targetId: 'note-1',
      dueAt: '2026-01-10T10:00:00Z'
    })
  })

  it('should handle create errors', async () => {
    ;(window.api.reminders.create as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Failed to create reminder')
    )

    const { result } = renderHook(() => useCreateReminder(), { wrapper })

    await expect(
      act(async () => {
        await result.current.mutateAsync({
          targetType: 'note',
          targetId: 'note-1',
          dueAt: '2026-01-10T10:00:00Z'
        })
      })
    ).rejects.toThrow('Failed to create reminder')
  })
})

// ============================================================================
// Update Reminder Tests
// ============================================================================

describe('useUpdateReminder', () => {
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

  it('should update a reminder successfully', async () => {
    ;(window.api.reminders.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true
    })

    const { result } = renderHook(() => useUpdateReminder(), { wrapper })

    await act(async () => {
      await result.current.mutateAsync({
        id: 'rem-1',
        dueAt: '2026-01-15T10:00:00Z'
      })
    })

    expect(window.api.reminders.update).toHaveBeenCalledWith({
      id: 'rem-1',
      dueAt: '2026-01-15T10:00:00Z'
    })
  })
})

// ============================================================================
// Delete Reminder Tests
// ============================================================================

describe('useDeleteReminder', () => {
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

  it('should delete a reminder successfully', async () => {
    ;(window.api.reminders.delete as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true
    })

    const { result } = renderHook(() => useDeleteReminder(), { wrapper })

    await act(async () => {
      await result.current.mutateAsync('rem-1')
    })

    expect(window.api.reminders.delete).toHaveBeenCalledWith('rem-1')
  })
})

// ============================================================================
// Dismiss Reminder Tests
// ============================================================================

describe('useDismissReminder', () => {
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

  it('should dismiss a reminder successfully', async () => {
    ;(window.api.reminders.dismiss as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true
    })

    const { result } = renderHook(() => useDismissReminder(), { wrapper })

    await act(async () => {
      await result.current.mutateAsync('rem-1')
    })

    expect(window.api.reminders.dismiss).toHaveBeenCalledWith('rem-1')
  })
})

// ============================================================================
// Snooze Reminder Tests
// ============================================================================

describe('useSnoozeReminder', () => {
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

  it('should snooze a reminder successfully', async () => {
    ;(window.api.reminders.snooze as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true
    })

    const { result } = renderHook(() => useSnoozeReminder(), { wrapper })

    await act(async () => {
      await result.current.mutateAsync({
        id: 'rem-1',
        snoozeUntil: '2026-01-05T14:00:00Z'
      })
    })

    expect(window.api.reminders.snooze).toHaveBeenCalledWith({
      id: 'rem-1',
      snoozeUntil: '2026-01-05T14:00:00Z'
    })
  })
})
