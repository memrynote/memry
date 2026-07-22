/**
 * The two async sources behind the canvas "Add card" picker.
 *
 * Notes and tasks come from quick-search. Events do NOT — the search index has
 * no calendar_event ContentType — so they come from one bounded
 * calendar.getRange call per dialog open, filtered client-side.
 */

import { useEffect, useState } from 'react'
import type { CalendarProjectionItem } from '@memry/contracts/calendar-api'
import type { SearchResultItem } from '@memry/contracts/search-api'
import { calendarService } from '@/services/calendar-service'
import { searchService } from '@/services/search-service'
import { createLogger } from '@/lib/logger'
import { eventRange } from './canvas-add-card'

const log = createLogger('SpatialCanvas')

const SEARCH_DEBOUNCE_MS = 150

export interface CanvasAddSources {
  results: SearchResultItem[]
  projections: CalendarProjectionItem[]
  loading: boolean
}

export function useCanvasAddSearch(open: boolean, query: string): CanvasAddSources {
  const [results, setResults] = useState<SearchResultItem[]>([])
  const [projections, setProjections] = useState<CalendarProjectionItem[]>([])
  const [loading, setLoading] = useState(false)

  // Events load once per open: getRange is a bounded window, not a query, so
  // re-fetching per keystroke would decrypt the same set repeatedly.
  useEffect(() => {
    if (!open) {
      setProjections([])
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const range = eventRange(Date.now())
        const response = await calendarService.getRange({
          ...range,
          includeUnselectedSources: false
        })
        if (!cancelled) {
          setProjections(response.items)
        }
      } catch (err) {
        log.error('Canvas add-card: failed to load events', err)
        if (!cancelled) {
          setProjections([])
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    if (!open || query.trim() === '') {
      setResults([])
      setLoading(false)
      return
    }
    setLoading(true)
    let cancelled = false
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const response = await searchService.quick(query)
          if (!cancelled) {
            setResults(response.results)
          }
        } catch (err) {
          log.error('Canvas add-card: search failed', err)
          if (!cancelled) {
            setResults([])
          }
        } finally {
          if (!cancelled) {
            setLoading(false)
          }
        }
      })()
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, query])

  return { results, projections, loading }
}
