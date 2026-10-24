import { useCallback } from 'react'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useQuery } from '@tanstack/react-query'
import type { MonthStats } from '../../../preload/index.d'
import { journalService } from '@/services/journal-service'
import { journalKeys, ENTRY_STALE_TIME, ENTRY_GC_TIME } from './journal-query-keys'
import { useJournalChangeInvalidation } from './use-journal-invalidation'

export interface UseYearStatsResult {
  data: MonthStats[]
  isLoading: boolean
  error: string | null
  reload: () => Promise<void>
}

export function useYearStats(year: number): UseYearStatsResult {
  const {
    data = [],
    isLoading,
    error: queryError,
    refetch
  } = useQuery({
    queryKey: journalKeys.yearStatsForYear(year),
    queryFn: () => journalService.getYearStats(year),
    staleTime: ENTRY_STALE_TIME,
    gcTime: ENTRY_GC_TIME
  })

  useJournalChangeInvalidation(
    journalKeys.yearStatsForYear(year),
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
