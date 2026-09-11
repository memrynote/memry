import { useEffect, useState } from 'react'
import type { CalendarEventSearchItem } from '@memry/contracts/calendar-api'
import type { SearchResultItem } from '@memry/contracts/search-api'
import { calendarService } from '@/services/calendar-service'
import { canvasService } from '@/services/canvas-service'
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
  canvases: RelationSearchResult[]
  /** `id` is the entry's local ISO date — a journal's identity is its day. */
  journals: RelationSearchResult[]
  loading: boolean
}

/** Canvases a single query can offer. Matches the picker's other groups. */
const CANVAS_RESULT_LIMIT = 10

/**
 * Reuses the same two search channels as the canvas add-card picker
 * (searchService.quick + calendarService.searchEvents) rather than adding a
 * new IPC channel. Journal entries ride the same quick-search response — it has
 * always returned them, the relation picker simply dropped them on the floor.
 * Canvases have no FTS index, so they come from `canvasService.list()` filtered
 * on the title in the renderer; the list is the same one the sidebar renders,
 * so it is small and already warm. Unlike the canvas picker, notes are NOT restricted to
 * markdown: a relation can point at a filed file too (`note_cache` rows
 * discriminated by fileType), so "Notes & Files" is one merged group fed by
 * every `type: 'note'` hit, whatever its fileType.
 */
export function useRelationSearch(query: string): RelationSearchState {
  const [notes, setNotes] = useState<RelationSearchResult[]>([])
  const [tasks, setTasks] = useState<RelationSearchResult[]>([])
  const [events, setEvents] = useState<RelationSearchResult[]>([])
  const [canvases, setCanvases] = useState<RelationSearchResult[]>([])
  const [journals, setJournals] = useState<RelationSearchResult[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed === '') {
      setNotes([])
      setTasks([])
      setEvents([])
      setCanvases([])
      setJournals([])
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
          setJournals(
            response.results.flatMap((r) =>
              r.metadata.type === 'journal'
                ? [{ id: r.metadata.date, title: r.title || r.metadata.date }]
                : []
            )
          )
        },
        (err: unknown) => {
          if (cancelled) return
          log.error('Note/task/journal search failed:', extractErrorMessage(err))
          setNotes([])
          setTasks([])
          setJournals([])
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
      const lowered = trimmed.toLowerCase()
      // Wrapped rather than called bare: the window-api forwarder throws
      // SYNCHRONOUSLY when the canvas bridge is not on `window.api` yet, and a
      // synchronous throw here would escape the rejection handler below and
      // surface as an unhandled error instead of an empty canvas group.
      const searchingCanvases = Promise.resolve()
        .then(() => canvasService.list())
        .then(
          (response) => {
            if (cancelled) return
            setCanvases(
              response.canvases
                .filter((c) => (c.title ?? '').toLowerCase().includes(lowered))
                .slice(0, CANVAS_RESULT_LIMIT)
                .map((c) => ({ id: c.id, title: c.title ?? '' }))
            )
          },
          (err: unknown) => {
            if (cancelled) return
            log.error('Canvas search failed:', extractErrorMessage(err))
            setCanvases([])
          }
        )
      void Promise.all([searching, searchingEvents, searchingCanvases]).then(() => {
        if (!cancelled) setLoading(false)
      })
    }, SEARCH_DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query])

  return { notes, tasks, events, canvases, journals, loading }
}
