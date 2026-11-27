/**
 * useReminders Hook Tests (T507-T508)
 * Tests for reminder hooks: list, create, update, delete, snooze, and dismiss.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import type { QueryClient } from '@tanstack/react-query'
import { QueryClientProvider } from '@tanstack/react-query'
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

const commands = vi.hoisted(() => ({
  reminderList: vi.fn(),
  reminderGetForTarget: vi.fn(),
  reminderCreate: vi.fn(),
  reminderUpdate: vi.fn(),
  reminderDelete: vi.fn(),
  reminderDismiss: vi.fn(),
  reminderSnooze: vi.fn()
}))
type Listener = (event: { payload: unknown }) => void
const listeners = vi.hoisted(() => new Map<string, Listener>())
const events = vi.hoisted(() => {
  const event = (name: string) => ({
    listen: vi.fn((listener: Listener) => {
      listeners.set(name, listener)
      return Promise.resolve(() => undefined)
    })
  })
  return {
    reminderCreatedEvent: event('created'),
    reminderUpdatedEvent: event('updated'),
    reminderDeletedEvent: event('deleted'),
    reminderDismissedEvent: event('dismissed'),
    reminderSnoozedEvent: event('snoozed'),
    syncItemSyncedEvent: event('synced')
  }
})
vi.mock('../../../generated/bindings', () => ({ commands, events }))

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

      commands.reminderList.mockResolvedValue({
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
      expect(commands.reminderList).toHaveBeenCalled()
    })

    it('should load reminders with filters', async () => {
      commands.reminderList.mockResolvedValue({
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

      expect(commands.reminderList).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'pending',
          limit: 10
        })
      )
    })

    it('should handle loading errors gracefully', async () => {
      commands.reminderList.mockRejectedValue(new Error('Failed to load reminders'))

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

      commands.reminderGetForTarget.mockResolvedValue(mockReminders)

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

      expect(commands.reminderGetForTarget).not.toHaveBeenCalled()
      expect(result.current.reminders).toEqual([])
    })
  })

  // ==========================================================================
  // Reminder events
  //
  // Each reminder command event carries the reminder's id and target
  // (`ReminderHint`); a view of another target ignores it.
  // ==========================================================================

  describe('reminder events', () => {
    const emit = (name: string, payload: unknown): void => listeners.get(name)?.({ payload })
    const onThisTarget = { reminder: { id: 'rem-1', targetType: 'note_date', targetId: 'note-1' } }

    const mountForTarget = async () => {
      commands.reminderGetForTarget.mockResolvedValue([])

      const { result } = renderHook(() => useRemindersForTarget('note_date', 'note-1'), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })
      expect(commands.reminderGetForTarget).toHaveBeenCalledTimes(1)

      return result
    }

    it('refetches on a created event for this target', async () => {
      await mountForTarget()

      emit('created', onThisTarget)

      await waitFor(() => {
        expect(commands.reminderGetForTarget).toHaveBeenCalledTimes(2)
      })
    })

    it('refetches on an updated event for this target', async () => {
      await mountForTarget()

      emit('updated', onThisTarget)

      await waitFor(() => {
        expect(commands.reminderGetForTarget).toHaveBeenCalledTimes(2)
      })
    })

    it('refetches on a deleted event for this target', async () => {
      await mountForTarget()

      emit('deleted', onThisTarget)

      await waitFor(() => {
        expect(commands.reminderGetForTarget).toHaveBeenCalledTimes(2)
      })
    })

    it('ignores an event for a different target', async () => {
      await mountForTarget()

      emit('created', { reminder: { id: 'rem-2', targetType: 'note', targetId: 'other-note' } })

      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(commands.reminderGetForTarget).toHaveBeenCalledTimes(1)
    })

    // Another device's change reaches this one as a pulled item that names only the id
    // (Electron's sync handler sends `{ id }`), so every reminder view refetches.
    it('refetches on a pulled reminder change (another device dismissed it)', async () => {
      await mountForTarget()

      emit('synced', {
        operation: 'pull',
        items: [{ itemId: 'rem-remote', type: 'reminder', itemOperation: 'update' }]
      })

      await waitFor(() => {
        expect(commands.reminderGetForTarget).toHaveBeenCalledTimes(2)
      })
    })

    it('ignores a pushed reminder and a pulled item of another type', async () => {
      await mountForTarget()

      emit('synced', {
        operation: 'push',
        items: [{ itemId: 'rem-1', type: 'reminder', itemOperation: 'update' }]
      })
      emit('synced', {
        operation: 'pull',
        items: [{ itemId: 'task-1', type: 'task', itemOperation: 'update' }]
      })

      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(commands.reminderGetForTarget).toHaveBeenCalledTimes(1)
    })

    it('refetches a reminder list on a pulled reminder change', async () => {
      commands.reminderList.mockResolvedValue({ reminders: [], total: 0, hasMore: false })
      const { result } = renderHook(() => useReminders(), { wrapper })
      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      emit('synced', {
        operation: 'pull',
        items: [{ itemId: 'rem-remote', type: 'reminder', itemOperation: 'update' }]
      })

      await waitFor(() => {
        expect(commands.reminderList).toHaveBeenCalledTimes(2)
      })
    })

    it('refetches on a dismissed event for this target', async () => {
      await mountForTarget()

      emit('dismissed', onThisTarget)

      await waitFor(() => {
        expect(commands.reminderGetForTarget).toHaveBeenCalledTimes(2)
      })
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

    commands.reminderCreate.mockResolvedValue(newReminder)

    const { result } = renderHook(() => useCreateReminder(), { wrapper })

    await act(async () => {
      await result.current.mutateAsync({
        targetType: 'note',
        targetId: 'note-1',
        dueAt: '2026-01-10T10:00:00Z'
      })
    })

    expect(commands.reminderCreate).toHaveBeenCalledWith({
      targetType: 'note',
      targetId: 'note-1',
      dueAt: '2026-01-10T10:00:00Z'
    })
  })

  it('answers a refused create with its message, as Electron withErrorHandler does', async () => {
    commands.reminderCreate.mockRejectedValue(new Error('Failed to create reminder'))

    const { result } = renderHook(() => useCreateReminder(), { wrapper })

    let response: unknown
    await act(async () => {
      response = await result.current.mutateAsync({
        targetType: 'note',
        targetId: 'note-1',
        remindAt: '2026-01-10T10:00:00Z'
      })
    })
    expect(response).toEqual({
      success: false,
      reminder: null,
      error: 'Failed to create reminder'
    })
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
    commands.reminderUpdate.mockResolvedValue(createMockReminder({ id: 'rem-1' }))

    const { result } = renderHook(() => useUpdateReminder(), { wrapper })

    await act(async () => {
      await result.current.mutateAsync({
        id: 'rem-1',
        dueAt: '2026-01-15T10:00:00Z'
      })
    })

    expect(commands.reminderUpdate).toHaveBeenCalledWith({
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
    commands.reminderDelete.mockResolvedValue(createMockReminder({ id: 'rem-1' }))

    const { result } = renderHook(() => useDeleteReminder(), { wrapper })

    await act(async () => {
      await result.current.mutateAsync('rem-1')
    })

    expect(commands.reminderDelete).toHaveBeenCalledWith('rem-1')
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
    commands.reminderDismiss.mockResolvedValue(createMockReminder({ id: 'rem-1' }))

    const { result } = renderHook(() => useDismissReminder(), { wrapper })

    await act(async () => {
      await result.current.mutateAsync('rem-1')
    })

    expect(commands.reminderDismiss).toHaveBeenCalledWith('rem-1')
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
    commands.reminderSnooze.mockResolvedValue(createMockReminder({ id: 'rem-1' }))

    const { result } = renderHook(() => useSnoozeReminder(), { wrapper })

    await act(async () => {
      await result.current.mutateAsync({
        id: 'rem-1',
        snoozeUntil: '2026-01-05T14:00:00Z'
      })
    })

    expect(commands.reminderSnooze).toHaveBeenCalledWith({
      id: 'rem-1',
      snoozeUntil: '2026-01-05T14:00:00Z'
    })
  })
})
