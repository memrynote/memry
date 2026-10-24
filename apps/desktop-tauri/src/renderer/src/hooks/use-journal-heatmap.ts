import { useCallback } from 'react'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useQuery } from '@tanstack/react-query'
import type { HeatmapEntry } from '../../../preload/index.d'
import { journalService } from '@/services/journal-service'
import { journalKeys, ENTRY_STALE_TIME, ENTRY_GC_TIME } from './journal-query-keys'

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

  // No local journal-change subscription here on purpose: `useJournalChangeEvents`
  // invalidates `journalKeys.heatmap(<year of the changed date>)` from App level, which
  // is the same predicate but survives the Home board being a background tab.

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
