import { useEffect, useCallback } from 'react'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { DayContext, DayTask } from '../../../preload/index.d'
import { journalService } from '@/services/journal-service'
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
    const unsubscribeTaskUpdated = window.api.onTaskUpdated((event) => {
      if (event.task.dueDate === date || event.changes?.dueDate === date) {
        queryClient.invalidateQueries({ queryKey: journalKeys.dayContextForDate(date) })
      }
    })

    const unsubscribeTaskCreated = window.api.onTaskCreated((event) => {
      if (event.task.dueDate === date) {
        queryClient.invalidateQueries({ queryKey: journalKeys.dayContextForDate(date) })
      }
    })

    const unsubscribeTaskDeleted = window.api.onTaskDeleted(() => {
      queryClient.invalidateQueries({ queryKey: journalKeys.dayContextForDate(date) })
    })

    const unsubscribeTaskCompleted = window.api.onTaskCompleted((event) => {
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
