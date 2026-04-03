import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  onJournalEntryCreated,
  onJournalEntryUpdated,
  onJournalEntryDeleted
} from '@/services/journal-service'

/**
 * Subscribes to journal entry IPC events (created/updated/deleted) and
 * invalidates the given query key when `matchDate` returns true.
 *
 * Uses refs so the effect never re-subscribes — only queryClient (stable)
 * is in the dependency array.
 */
export function useJournalChangeInvalidation(
  queryKey: readonly unknown[],
  matchDate: (eventDate: string) => boolean
): void {
  const queryClient = useQueryClient()
  const matchDateRef = useRef(matchDate)
  matchDateRef.current = matchDate
  const queryKeyRef = useRef(queryKey)
  queryKeyRef.current = queryKey

  useEffect(() => {
    const invalidate = (eventDate: string) => {
      if (matchDateRef.current(eventDate)) {
        queryClient.invalidateQueries({ queryKey: queryKeyRef.current })
      }
    }

    const unsubCreated = onJournalEntryCreated((e) => invalidate(e.date))
    const unsubUpdated = onJournalEntryUpdated((e) => invalidate(e.date))
    const unsubDeleted = onJournalEntryDeleted((e) => invalidate(e.date))

    return () => {
      unsubCreated()
      unsubUpdated()
      unsubDeleted()
    }
  }, [queryClient])
}
