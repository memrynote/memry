import { useCallback } from 'react'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useQuery } from '@tanstack/react-query'
import type { MonthEntryPreview } from '../../../preload/index.d'
import { journalService } from '@/services/journal-service'
import { journalKeys, ENTRY_STALE_TIME, ENTRY_GC_TIME } from './journal-query-keys'
import { useJournalChangeInvalidation } from './use-journal-invalidation'

export interface UseMonthEntriesResult {
  data: MonthEntryPreview[]
  isLoading: boolean
  error: string | null
  reload: () => Promise<void>
}

export function useMonthEntries(year: number, month: number): UseMonthEntriesResult {
  const {
    data = [],
    isLoading,
    error: queryError,
    refetch
  } = useQuery({
    queryKey: journalKeys.monthEntriesForMonth(year, month),
    queryFn: () => journalService.getMonthEntries(year, month),
    staleTime: ENTRY_STALE_TIME,
    gcTime: ENTRY_GC_TIME
  })

  useJournalChangeInvalidation(
    journalKeys.monthEntriesForMonth(year, month),
    (eventDate) => {
      const eventYear = parseInt(eventDate.slice(0, 4), 10)
      const eventMonth = parseInt(eventDate.slice(5, 7), 10)
      return eventYear === year && eventMonth === month
    }
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
