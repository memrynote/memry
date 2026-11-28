import { useEffect, useCallback } from 'react'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { DayContext, DayTask } from '../../../preload/index.d'
import { journalService } from '@/services/journal-service'
import {
  onTaskCompleted,
  onTaskCreated,
  onTaskDeleted,
  onTaskUpdated
} from '@/services/tasks-service'
import { journalKeys, ENTRY_STALE_TIME, ENTRY_GC_TIME } from './journal-query-keys'

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
    const unsubscribeTaskUpdated = onTaskUpdated((event) => {
      if (event.task.dueDate === date || event.changes?.dueDate === date) {
        void queryClient.invalidateQueries({ queryKey: journalKeys.dayContextForDate(date) })
      }
    })

    const unsubscribeTaskCreated = onTaskCreated((event) => {
      if (event.task.dueDate === date) {
        void queryClient.invalidateQueries({ queryKey: journalKeys.dayContextForDate(date) })
      }
    })

    const unsubscribeTaskDeleted = onTaskDeleted(() => {
      void queryClient.invalidateQueries({ queryKey: journalKeys.dayContextForDate(date) })
    })

    const unsubscribeTaskCompleted = onTaskCompleted((event) => {
      if (event.task.dueDate === date) {
        void queryClient.invalidateQueries({ queryKey: journalKeys.dayContextForDate(date) })
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
