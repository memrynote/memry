/**
 * Reminder Hooks
 *
 * React hooks for managing reminders in the renderer process.
 * Uses TanStack Query for caching and real-time updates.
 *
 * @module hooks/use-reminders
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import {
  reminderService,
  onReminderCreated,
  onReminderUpdated,
  onReminderDeleted,
  onReminderDismissed,
  onReminderSnoozed,
  type CreateReminderInput,
  type UpdateReminderInput,
  type SnoozeReminderInput,
  type ListRemindersInput,
  type ReminderTargetType
} from '@/services/reminder-service'

// ============================================================================
// Query Keys
// ============================================================================

export const reminderKeys = {
  all: ['reminders'] as const,
  lists: () => [...reminderKeys.all, 'list'] as const,
  list: (options?: ListRemindersInput) => [...reminderKeys.lists(), options] as const,
  due: () => [...reminderKeys.all, 'due'] as const,
  forTarget: (targetType: ReminderTargetType, targetId: string) =>
    [...reminderKeys.all, 'target', targetType, targetId] as const,
  detail: (id: string) => [...reminderKeys.all, 'detail', id] as const
}

// ============================================================================
// Hooks
// ============================================================================

/**
 * Hook for listing reminders with optional filters
 */
export function useReminders(options?: ListRemindersInput): {
  reminders: Array<any>
  total: number
  hasMore: boolean
  isLoading: boolean
  error: any
  refetch: () => void
} {
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: reminderKeys.list(options),
    queryFn: () => reminderService.list(options),
    staleTime: 30 * 1000 // 30 seconds
  })

  // Subscribe to events for real-time updates
  useEffect(() => {
    const unsubs = [
      onReminderCreated(() => {
        queryClient.invalidateQueries({ queryKey: reminderKeys.lists() })
      }),
      onReminderUpdated(() => {
        queryClient.invalidateQueries({ queryKey: reminderKeys.lists() })
      }),
      onReminderDeleted(() => {
        queryClient.invalidateQueries({ queryKey: reminderKeys.lists() })
      }),
      onReminderDismissed(() => {
        queryClient.invalidateQueries({ queryKey: reminderKeys.lists() })
      }),
      onReminderSnoozed(() => {
        queryClient.invalidateQueries({ queryKey: reminderKeys.lists() })
      })
    ]

    return () => unsubs.forEach((unsub) => unsub())
  }, [queryClient])

  return {
    reminders: query.data?.reminders ?? [],
    total: query.data?.total ?? 0,
    hasMore: query.data?.hasMore ?? false,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch
  }
}

/**
 * Hook for getting reminders for a specific target (note, journal, highlight)
 */
export function useRemindersForTarget(
  targetType: ReminderTargetType,
  targetId: string
): {
  reminders: Array<any>
  hasReminders: boolean
  isLoading: boolean
  error: any
  refetch: () => void
} {
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: reminderKeys.forTarget(targetType, targetId),
    queryFn: () => reminderService.getForTarget(targetType, targetId),
    enabled: !!targetId,
    staleTime: 30 * 1000
  })

  // Subscribe to events for real-time updates
  useEffect(() => {
    if (!targetId) return

    const unsubs = [
      onReminderCreated((event) => {
        if (event.reminder.targetType === targetType && event.reminder.targetId === targetId) {
          queryClient.invalidateQueries({
            queryKey: reminderKeys.forTarget(targetType, targetId)
          })
        }
      }),
      onReminderDeleted((event) => {
        if (event.targetType === targetType && event.targetId === targetId) {
          queryClient.invalidateQueries({
            queryKey: reminderKeys.forTarget(targetType, targetId)
          })
        }
      }),
      onReminderDismissed((event) => {
        if (event.reminder.targetType === targetType && event.reminder.targetId === targetId) {
          queryClient.invalidateQueries({
            queryKey: reminderKeys.forTarget(targetType, targetId)
          })
        }
      })
    ]

    return () => unsubs.forEach((unsub) => unsub())
  }, [queryClient, targetType, targetId])

  return {
    reminders: query.data ?? [],
    hasReminders: (query.data?.length ?? 0) > 0,
    isLoading: query.isLoading,
    error: query.error,
    refetch: () => query.refetch()
  }
}

// ============================================================================
// Mutations
// ============================================================================

/**
 * Hook for creating a reminder
 */
export function useCreateReminder() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: CreateReminderInput) => reminderService.create(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: reminderKeys.lists() })
    }
  })
}

/**
 * Hook for updating a reminder
 */
export function useUpdateReminder() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: UpdateReminderInput) => reminderService.update(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: reminderKeys.lists() })
    }
  })
}

/**
 * Hook for deleting a reminder
 */
export function useDeleteReminder() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: string) => reminderService.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: reminderKeys.lists() })
    }
  })
}

/**
 * Hook for dismissing a reminder
 */
export function useDismissReminder() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: string) => reminderService.dismiss(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: reminderKeys.lists() })
    }
  })
}

/**
 * Hook for snoozing a reminder
 */
export function useSnoozeReminder() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: SnoozeReminderInput) => reminderService.snooze(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: reminderKeys.lists() })
    }
  })
}
