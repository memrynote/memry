import { useQuery } from '@tanstack/react-query'
import type { SameDayEntry } from '@memry/contracts/journal-api'
import { journalService } from '@/services/journal-service'
import { journalKeys, ENTRY_STALE_TIME, ENTRY_GC_TIME } from './journal-query-keys'

export interface UseSameDayEntriesResult {
  entries: SameDayEntry[]
  error: Error | null
}

/**
 * Entries from other years shown as the same day as `date`, newest first.
 * `useJournalChangeEvents` invalidates it when one of those days changes.
 */
export function useSameDayEntries(date: string): UseSameDayEntriesResult {
  const { data, error } = useQuery({
    queryKey: journalKeys.sameDayForDate(date),
    queryFn: () => journalService.getSameDayEntries(date),
    staleTime: ENTRY_STALE_TIME,
    gcTime: ENTRY_GC_TIME
  })

  return { entries: data ?? [], error }
}
