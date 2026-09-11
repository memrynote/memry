import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  onJournalEntryCreated,
  onJournalEntryUpdated,
  onJournalEntryDeleted,
  onJournalExternalChange
} from '@/services/journal-service'
import { journalKeys } from './journal-query-keys'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * App-level cache invalidation for journal entry and heatmap queries.
 *
 * The only listeners for the main process's `journal:entry*` broadcasts lived inside
 * components: `useJournalChangeInvalidation` (heatmap/month/stats/streak) and
 * `useJournalEntry`, which patches the cache for the one date its editor has open.
 * A tab group mounts only its active tab, so a change that landed while the Home
 * board sat in a background tab reached nobody, the cached heatmap and entries stayed
 * inside the app's 30s `staleTime`, and react-query served the stale cache when the
 * board came back. The widget never refetches on its own: no `refetchInterval`, and
 * `refetchOnWindowFocus` is off.
 *
 * The Home journal widget's *entry* previews had no listener at all. Their only
 * refresh came from `useJournalEntry`'s own update mutation, which is bypassed by the
 * pending-save-on-date-switch path, by another window, by the vault file watcher and
 * by sync writeback -- all of which only broadcast.
 *
 * Mounted once in `App.tsx`, this listener outlives every tab switch: an unmounted
 * board's queries are marked invalidated when the change happens and refetch the
 * moment it is shown again. Same shape as `useCalendarChangeEvents`.
 */
export function useJournalChangeEvents(): void {
  const queryClient = useQueryClient()

  useEffect(() => {
    const invalidate = (date: unknown): void => {
      if (typeof date !== 'string' || !ISO_DATE.test(date)) return

      void queryClient.invalidateQueries({ queryKey: journalKeys.entry(date) })
      void queryClient.invalidateQueries({
        queryKey: journalKeys.heatmap(Number(date.slice(0, 4)))
      })
    }

    const unsubscribeCreated = onJournalEntryCreated((event) => invalidate(event.date))
    const unsubscribeUpdated = onJournalEntryUpdated((event) => invalidate(event.date))
    const unsubscribeDeleted = onJournalEntryDeleted((event) => invalidate(event.date))
    const unsubscribeExternal = onJournalExternalChange((event) => invalidate(event.date))

    return () => {
      unsubscribeCreated()
      unsubscribeUpdated()
      unsubscribeDeleted()
      unsubscribeExternal()
    }
  }, [queryClient])
}
