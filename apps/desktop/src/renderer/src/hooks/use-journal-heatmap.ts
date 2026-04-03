import { useCallback } from 'react'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useQuery } from '@tanstack/react-query'
import type { HeatmapEntry } from '../../../preload/index.d'
import { journalService } from '@/services/journal-service'
import { journalKeys, ENTRY_STALE_TIME, ENTRY_GC_TIME } from './journal-query-keys'
import { useJournalChangeInvalidation } from './use-journal-invalidation'

export interface UseJournalHeatmapResult {
  data: HeatmapEntry[]
  isLoading: boolean
  error: string | null
  reload: () => Promise<void>
}

export function useJournalHeatmap(year: number): UseJournalHeatmapResult {
  const {
    data = [],
    isLoading,
    error: queryError,
    refetch
  } = useQuery({
    queryKey: journalKeys.heatmap(year),
    queryFn: () => journalService.getHeatmap(year),
    staleTime: ENTRY_STALE_TIME,
    gcTime: ENTRY_GC_TIME
  })

  useJournalChangeInvalidation(
    journalKeys.heatmap(year),
    (eventDate) => parseInt(eventDate.slice(0, 4), 10) === year
  )

  const reload = useCallback(async () => {
    await refetch()
  }, [refetch])

  return {
    data,
    isLoading,
    error: queryError ? extractErrorMessage(queryError) : null,
    reload
  }
}
