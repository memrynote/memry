/**
 * useTasksLinkedToNote Hook Tests (T490-T493 partial)
 * Tests for tasks hooks: list linked tasks and refresh functionality.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { useTasksLinkedToNote } from './use-tasks-linked-to-note'
import {
  createTestQueryClient,
  createMockTask,
  setupHookTestEnvironment,
  cleanupHookTestEnvironment
} from '@tests/utils/hook-test-wrapper'

// ============================================================================
// Test Setup
// ============================================================================

describe('useTasksLinkedToNote', () => {
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
  // T490: List Tasks Linked to Note
  // ==========================================================================

  describe('list linked tasks', () => {
    it('should load tasks linked to a note', async () => {
      const mockTasks = [
        createMockTask({ id: 'task-1', title: 'Task 1' }),
        createMockTask({ id: 'task-2', title: 'Task 2' })
      ]

      ;(window.api.tasks.getLinkedTasks as ReturnType<typeof vi.fn>).mockResolvedValue(mockTasks)

      const { result } = renderHook(() => useTasksLinkedToNote('note-1'), { wrapper })

      // Initially loading
      expect(result.current.isLoading).toBe(true)

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(result.current.tasks).toHaveLength(2)
      expect(result.current.tasks[0].id).toBe('task-1')
      expect(window.api.tasks.getLinkedTasks).toHaveBeenCalledWith('note-1')
    })

    it('should return empty array when noteId is null', async () => {
      const { result } = renderHook(() => useTasksLinkedToNote(null), { wrapper })

      // Should not be loading when noteId is null
      expect(result.current.isLoading).toBe(false)
      expect(result.current.tasks).toEqual([])
      expect(window.api.tasks.getLinkedTasks).not.toHaveBeenCalled()
    })

    it('should handle loading errors gracefully', async () => {
      ;(window.api.tasks.getLinkedTasks as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Failed to load linked tasks')
      )

      const { result } = renderHook(() => useTasksLinkedToNote('note-1'), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(result.current.error).toBe('Failed to load linked tasks')
      expect(result.current.tasks).toEqual([])
    })

    it('should reload when noteId changes', async () => {
      const tasks1 = [createMockTask({ id: 'task-1' })]
      const tasks2 = [createMockTask({ id: 'task-2' })]

      ;(window.api.tasks.getLinkedTasks as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(tasks1)
        .mockResolvedValueOnce(tasks2)

      const { result, rerender } = renderHook(({ noteId }) => useTasksLinkedToNote(noteId), {
        wrapper,
        initialProps: { noteId: 'note-1' }
      })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(result.current.tasks[0].id).toBe('task-1')

      // Change noteId
      rerender({ noteId: 'note-2' })

      await waitFor(() => {
        expect(result.current.tasks[0]?.id).toBe('task-2')
      })

      expect(window.api.tasks.getLinkedTasks).toHaveBeenCalledWith('note-2')
    })
  })

  // ==========================================================================
  // T493: Refresh Functionality
  // ==========================================================================

  describe('refresh functionality', () => {
    it('should refresh tasks when refresh is called', async () => {
      const tasks = [createMockTask({ id: 'task-1' })]

      ;(window.api.tasks.getLinkedTasks as ReturnType<typeof vi.fn>).mockResolvedValue(tasks)

      const { result } = renderHook(() => useTasksLinkedToNote('note-1'), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(window.api.tasks.getLinkedTasks).toHaveBeenCalledTimes(1)

      // Call refresh
      act(() => {
        result.current.refresh()
      })

      await waitFor(() => {
        expect(window.api.tasks.getLinkedTasks).toHaveBeenCalledTimes(2)
      })
    })

    it('should not refresh when noteId is null', async () => {
      const { result } = renderHook(() => useTasksLinkedToNote(null), { wrapper })

      // Call refresh
      act(() => {
        result.current.refresh()
      })

      // Should not have been called
      expect(window.api.tasks.getLinkedTasks).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // Event Subscriptions
  // ==========================================================================

  describe('event subscriptions', () => {
    it('should subscribe to task events and refresh when tasks change', async () => {
      const tasks = [createMockTask({ id: 'task-1' })]

      ;(window.api.tasks.getLinkedTasks as ReturnType<typeof vi.fn>).mockResolvedValue(tasks)

      const { result } = renderHook(() => useTasksLinkedToNote('note-1'), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      // Verify event subscriptions were set up
      expect(window.api.onTaskCreated).toHaveBeenCalled()
      expect(window.api.onTaskUpdated).toHaveBeenCalled()
      expect(window.api.onTaskDeleted).toHaveBeenCalled()
    })

    it('should not subscribe to events when noteId is null', async () => {
      renderHook(() => useTasksLinkedToNote(null), { wrapper })

      // Wait a tick
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Events should not have been called for subscription (initial call may exist)
      // The subscriptions happen inside useEffect which depends on noteId
      expect(window.api.tasks.getLinkedTasks).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // Clear State
  // ==========================================================================

  describe('clear state', () => {
    it('should clear tasks when noteId becomes null', async () => {
      const tasks = [createMockTask({ id: 'task-1' })]

      ;(window.api.tasks.getLinkedTasks as ReturnType<typeof vi.fn>).mockResolvedValue(tasks)

      const { result, rerender } = renderHook(({ noteId }) => useTasksLinkedToNote(noteId), {
        wrapper,
        initialProps: { noteId: 'note-1' as string | null }
      })

      await waitFor(() => {
        expect(result.current.tasks).toHaveLength(1)
      })

      // Set noteId to null
      rerender({ noteId: null })

      expect(result.current.tasks).toEqual([])
      expect(result.current.error).toBeNull()
    })
  })
})
