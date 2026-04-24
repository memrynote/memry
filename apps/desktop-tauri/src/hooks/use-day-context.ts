import { useEffect, useCallback } from 'react'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { DayContext, DayTask } from '@/types/preload-types'
import { journalService } from '@/services/journal-service'
import { subscribeEvent } from '@/lib/ipc/forwarder'
import { journalKeys, ENTRY_STALE_TIME, ENTRY_GC_TIME } from './journal-query-keys'

interface TaskEvent {
  task: { dueDate?: string | null }
  changes?: { dueDate?: string | null }
}

export interface UseDayContextResult {
  data: DayContext | null
  tasks: DayTask[]
  events: DayContext['events']
  overdueCount: number
  isLoading: boolean
  error: string | null
  reload: () => Promise<void>
}

export function useDayContext(date: string): UseDayContextResult {
  const queryClient = useQueryClient()

  const {
    data,
    isLoading,
    error: queryError,
    refetch
  } = useQuery({
    queryKey: journalKeys.dayContextForDate(date),
    queryFn: () => journalService.getDayContext(date),
    staleTime: ENTRY_STALE_TIME,
    gcTime: ENTRY_GC_TIME
  })

  useEffect(() => {
    const unsubscribeTaskUpdated = subscribeEvent<TaskEvent>('task-updated', (event) => {
      if (event.task.dueDate === date || event.changes?.dueDate === date) {
        queryClient.invalidateQueries({ queryKey: journalKeys.dayContextForDate(date) })
      }
    })

    const unsubscribeTaskCreated = subscribeEvent<TaskEvent>('task-created', (event) => {
      if (event.task.dueDate === date) {
        queryClient.invalidateQueries({ queryKey: journalKeys.dayContextForDate(date) })
      }
    })

    const unsubscribeTaskDeleted = subscribeEvent<void>('task-deleted', () => {
      queryClient.invalidateQueries({ queryKey: journalKeys.dayContextForDate(date) })
    })

    const unsubscribeTaskCompleted = subscribeEvent<TaskEvent>('task-completed', (event) => {
      if (event.task.dueDate === date) {
        queryClient.invalidateQueries({ queryKey: journalKeys.dayContextForDate(date) })
      }
    })

    return () => {
      unsubscribeTaskUpdated()
      unsubscribeTaskCreated()
      unsubscribeTaskDeleted()
      unsubscribeTaskCompleted()
    }
  }, [date, queryClient])

  const reload = useCallback(async () => {
    await refetch()
  }, [refetch])

  return {
    data: data ?? null,
    tasks: data?.tasks ?? [],
    events: data?.events ?? [],
    overdueCount: data?.overdueCount ?? 0,
    isLoading,
    error: queryError ? extractErrorMessage(queryError) : null,
    reload
  }
}
