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
  type Reminder,
  type ReminderTargetType,
  type ReminderWithTarget
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
// Event helpers
// ============================================================================

/**
 * Reminder events reach the renderer from two producers. The local IPC path
 * (main/lib/reminders.ts) sends the resolved row, so the target can be compared
 * directly. The sync handler (main/sync/item-handlers/reminder-handler.ts) has
 * no resolved row for an inbound change and sends only `{ id }` — reading
 * `event.reminder.targetType` there threw and, before the preload fan-out was
 * hardened, killed every later listener on the channel.
 *
 * With no target on the event there is nothing to compare, so treat it as a
 * match: a redundant refetch is cheap, a missed one leaves stale UI.
 */
function eventMatchesTarget(
  event: {
    reminder?: { targetType?: string; targetId?: string } | null
    targetType?: string
    targetId?: string
  },
  targetType: ReminderTargetType,
  targetId: string
): boolean {
  const eventTargetType = event?.reminder?.targetType ?? event?.targetType
  const eventTargetId = event?.reminder?.targetId ?? event?.targetId
  if (!eventTargetType || !eventTargetId) return true
  return eventTargetType === targetType && eventTargetId === targetId
}

// ============================================================================
// Hooks
// ============================================================================

/**
 * Hook for listing reminders with optional filters
 */
export function useReminders(options?: ListRemindersInput): {
  reminders: ReminderWithTarget[]
  total: number
  hasMore: boolean
  isLoading: boolean
  error: Error | null
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
        void queryClient.invalidateQueries({ queryKey: reminderKeys.lists() })
      }),
      onReminderUpdated(() => {
        void queryClient.invalidateQueries({ queryKey: reminderKeys.lists() })
      }),
      onReminderDeleted(() => {
        void queryClient.invalidateQueries({ queryKey: reminderKeys.lists() })
      }),
      onReminderDismissed(() => {
        void queryClient.invalidateQueries({ queryKey: reminderKeys.lists() })
      }),
      onReminderSnoozed(() => {
        void queryClient.invalidateQueries({ queryKey: reminderKeys.lists() })
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
    refetch: (...args) => void query.refetch(...args)
  }
}

/**
 * Hook for getting reminders for a specific target (note, journal, highlight)
 */
export function useRemindersForTarget(
  targetType: ReminderTargetType,
  targetId: string
): {
  reminders: Reminder[]
  hasReminders: boolean
  isLoading: boolean
  error: Error | null
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

    const invalidateIfMatching = (event: Parameters<typeof eventMatchesTarget>[0]): void => {
      if (!eventMatchesTarget(event, targetType, targetId)) return
      void queryClient.invalidateQueries({
        queryKey: reminderKeys.forTarget(targetType, targetId)
      })
    }

    const unsubs = [
      onReminderCreated(invalidateIfMatching),
      // Sync applies an inbound dismiss/snooze as a plain merge and emits
      // UPDATED, never DISMISSED. Without this the fired pill, journal badge
      // and task chip keep showing a reminder the other device silenced.
      onReminderUpdated(invalidateIfMatching),
      onReminderDeleted(invalidateIfMatching),
      onReminderDismissed(invalidateIfMatching)
    ]

    return () => unsubs.forEach((unsub) => unsub())
  }, [queryClient, targetType, targetId])

  return {
    reminders: query.data ?? [],
    hasReminders: (query.data?.length ?? 0) > 0,
    isLoading: query.isLoading,
    error: query.error,
    refetch: () => void query.refetch()
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
      void queryClient.invalidateQueries({ queryKey: reminderKeys.lists() })
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
      void queryClient.invalidateQueries({ queryKey: reminderKeys.lists() })
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
      void queryClient.invalidateQueries({ queryKey: reminderKeys.lists() })
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
      void queryClient.invalidateQueries({ queryKey: reminderKeys.lists() })
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
      void queryClient.invalidateQueries({ queryKey: reminderKeys.lists() })
    }
  })
}
