import { useEffect, useState } from 'react'
import type { CalendarEventSearchItem } from '@memry/contracts/calendar-api'
import type { SearchResultItem } from '@memry/contracts/search-api'
import { calendarService } from '@/services/calendar-service'
import { searchService } from '@/services/search-service'
import { createLogger } from '@/lib/logger'
import { extractErrorMessage } from '@/lib/ipc-error'

const log = createLogger('RelationPicker')

// Mirrors the canvas add-card picker's debounce (use-canvas-add-search.ts):
// long enough to coalesce a burst of keystrokes into one request pair, short
// enough that the wait is imperceptible.
const SEARCH_DEBOUNCE_MS = 150

export interface RelationSearchResult {
  id: string
  title: string
}

export interface RelationSearchState {
  notes: RelationSearchResult[]
  tasks: RelationSearchResult[]
  events: RelationSearchResult[]
  loading: boolean
}

/**
 * Reuses the same two search channels as the canvas add-card picker
 * (searchService.quick + calendarService.searchEvents) rather than adding a
 * new IPC channel. Unlike the canvas picker, notes are NOT restricted to
 * markdown: a relation can point at a filed file too (`note_cache` rows
 * discriminated by fileType), so "Notes & Files" is one merged group fed by
 * every `type: 'note'` hit, whatever its fileType.
 */
export function useRelationSearch(query: string): RelationSearchState {
  const [notes, setNotes] = useState<RelationSearchResult[]>([])
  const [tasks, setTasks] = useState<RelationSearchResult[]>([])
  const [events, setEvents] = useState<RelationSearchResult[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed === '') {
      setNotes([])
      setTasks([])
      setEvents([])
      setLoading(false)
      return
    }

    setLoading(true)
    let cancelled = false
    const timer = setTimeout(() => {
      // Settled independently: one source failing must not blank the other.
      const searching = searchService.quick(trimmed).then(
        (response: { results: SearchResultItem[] }) => {
          if (cancelled) return
          setNotes(
            response.results
              .filter((r) => r.metadata.type === 'note')
              .map((r) => ({ id: r.id, title: r.title }))
          )
          setTasks(
            response.results
              .filter((r) => r.metadata.type === 'task')
              .map((r) => ({ id: r.id, title: r.title }))
          )
        },
        (err: unknown) => {
          if (cancelled) return
          log.error('Note/task search failed:', extractErrorMessage(err))
          setNotes([])
          setTasks([])
        }
      )
      const searchingEvents = calendarService.searchEvents({ query: trimmed }).then(
        (response: { events: CalendarEventSearchItem[] }) => {
          if (cancelled) return
          setEvents(response.events.map((e) => ({ id: e.id, title: e.title })))
        },
        (err: unknown) => {
          if (cancelled) return
          log.error('Event search failed:', extractErrorMessage(err))
          setEvents([])
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
  }, [query])

  return { notes, tasks, events, loading }
}
