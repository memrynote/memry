import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  onJournalEntryCreated,
  onJournalEntryUpdated,
  onJournalEntryDeleted,
  onJournalExternalChange,
  onJournalEventsDropped
} from '@/services/journal-service'
import { subscribeToEvents } from '@/services/tauri-event'
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
      void queryClient.invalidateQueries({ queryKey: journalKeys.propertyRows() })
    }

    const invalidateAll = (): void => {
      void queryClient.invalidateQueries({ queryKey: journalKeys.all })
    }

    // Missed events may have been any day's: dropped ones, and those sent before the listeners
    // went live, after the pages mounted with them read their days (#4270).
    return subscribeToEvents(
      [
        (live) => onJournalEntryCreated((event) => invalidate(event.date), live),
        (live) => onJournalEntryUpdated((event) => invalidate(event.date), live),
        (live) => onJournalEntryDeleted((event) => invalidate(event.date), live),
        (live) => onJournalExternalChange((event) => invalidate(event.date), live),
        (live) => onJournalEventsDropped(invalidateAll, live)
      ],
      invalidateAll
    )
  }, [queryClient])
}
