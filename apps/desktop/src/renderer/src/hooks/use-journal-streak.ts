import { useQuery } from '@tanstack/react-query'
import type { JournalStreak } from '../../../preload/index.d'
import { journalService } from '@/services/journal-service'
import { journalKeys, ENTRY_STALE_TIME, ENTRY_GC_TIME } from './journal-query-keys'
import { useJournalChangeInvalidation } from './use-journal-invalidation'

export interface UseJournalStreakResult {
  streak: JournalStreak | undefined
  isLoading: boolean
}

export function useJournalStreak(): UseJournalStreakResult {
  const { data, isLoading } = useQuery({
    queryKey: journalKeys.streak(),
    queryFn: () => journalService.getStreak(),
    staleTime: ENTRY_STALE_TIME,
    gcTime: ENTRY_GC_TIME
  })

  // Any journal change can shift the streak.
  useJournalChangeInvalidation(journalKeys.streak(), () => true)

  return { streak: data, isLoading }
}
