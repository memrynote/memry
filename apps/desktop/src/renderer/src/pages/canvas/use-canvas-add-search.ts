/**
 * The two async sources behind the canvas "Add card" picker.
 *
 * Notes and tasks come from quick-search; events come from
 * calendar:search-events (#869). Both are query-driven and share one debounce,
 * so every event is reachable — the old ±90-day getRange window is gone.
 */

import { useEffect, useState } from 'react'
import type { CalendarEventSearchItem } from '@memry/contracts/calendar-api'
import type { SearchResultItem } from '@memry/contracts/search-api'
import { calendarService } from '@/services/calendar-service'
import { searchService } from '@/services/search-service'
import { createLogger } from '@/lib/logger'

const log = createLogger('SpatialCanvas')

// The dialog's own highlight effect (canvas-add-card-dialog.tsx) relies on
// results landing in a LATER render commit than the query change: cmdk resets
// its highlight to the first mounted item whenever the search value changes,
// and the dialog's effect then re-highlights the first real match, winning
// because it runs after. Dropping this debounce (or making it 0) would let
// results commit in the same tick as the query change and the highlight
// would flicker to the create row on every keystroke.
const SEARCH_DEBOUNCE_MS = 150

export interface CanvasAddSources {
  results: SearchResultItem[]
  events: CalendarEventSearchItem[]
  loading: boolean
}

export function useCanvasAddSearch(open: boolean, query: string): CanvasAddSources {
  const [results, setResults] = useState<SearchResultItem[]>([])
  const [events, setEvents] = useState<CalendarEventSearchItem[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const trimmed = query.trim()
    if (!open || trimmed === '') {
      setResults([])
      setEvents([])
      setLoading(false)
      return
    }
    setLoading(true)
    let cancelled = false
    const timer = setTimeout(() => {
      // Settled independently: one source failing must not blank the other.
      const searching = searchService.quick(query).then(
        (response) => {
          if (!cancelled) setResults(response.results)
        },
        (err) => {
          if (!cancelled) {
            log.error('Canvas add-card: search failed', err)
            setResults([])
          }
        }
      )
      const searchingEvents = calendarService.searchEvents({ query: trimmed }).then(
        (response) => {
          if (!cancelled) setEvents(response.events)
        },
        (err) => {
          if (!cancelled) {
            log.error('Canvas add-card: event search failed', err)
            setEvents([])
          }
        }
      )
      void Promise.all([searching, searchingEvents]).then(() => {
        if (!cancelled) setLoading(false)
      })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, query])

  return { results, events, loading }
}
