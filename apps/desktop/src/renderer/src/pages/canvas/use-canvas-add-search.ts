/**
 * The async sources behind the canvas "Add card" picker.
 *
 * Notes, tasks and filed files come from quick-search; events come from
 * calendar:search-events (#869). Both are query-driven and share one debounce,
 * so every event is reachable — the old ±90-day getRange window is gone.
 * Projects are not in the search index, so they are listed once and the dialog
 * filters them against the query.
 */

import { useEffect, useState } from 'react'
import type { CalendarEventSearchItem } from '@memry/contracts/calendar-api'
import type { NoteFileType, SearchResultItem } from '@memry/contracts/search-api'
import { calendarService } from '@/services/calendar-service'
import { searchService } from '@/services/search-service'
import type { ProjectWithStats } from '@/services/tasks-service'
import { useProjectsList } from '@/hooks/use-projects-list'
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

// Quick-search caps results at 5 per type, and a filed binary is a "note" row
// (#800). One markdown-only call and one binary-only call give notes and files
// a cap each, so matching PDFs can no longer eat every note slot and leave the
// Notes group empty (#874).
const NOTE_FILE_TYPES: NoteFileType[] = ['markdown']
const FILED_FILE_TYPES: NoteFileType[] = ['pdf', 'image', 'audio', 'video']

export interface CanvasAddSources {
  results: SearchResultItem[]
  /** Binary "note" rows only; the binary-only call's task hits duplicate `results`. */
  files: SearchResultItem[]
  events: CalendarEventSearchItem[]
  projects: ProjectWithStats[]
  loading: boolean
}

export function useCanvasAddSearch(open: boolean, query: string): CanvasAddSources {
  const [results, setResults] = useState<SearchResultItem[]>([])
  const [files, setFiles] = useState<SearchResultItem[]>([])
  const [events, setEvents] = useState<CalendarEventSearchItem[]>([])
  const [loading, setLoading] = useState(false)
  const { projects } = useProjectsList()

  useEffect(() => {
    const trimmed = query.trim()
    if (!open || trimmed === '') {
      setResults([])
      setFiles([])
      setEvents([])
      setLoading(false)
      return
    }
    setLoading(true)
    let cancelled = false
    const timer = setTimeout(() => {
      // Settled independently: one source failing must not blank the others.
      const searching = searchService.quick(trimmed, NOTE_FILE_TYPES).then(
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
      const searchingFiles = searchService.quick(trimmed, FILED_FILE_TYPES).then(
        (response) => {
          if (!cancelled) {
            setFiles(response.results.filter((result) => result.metadata.type === 'note'))
          }
        },
        (err) => {
          if (!cancelled) {
            log.error('Canvas add-card: file search failed', err)
            setFiles([])
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
      void Promise.all([searching, searchingFiles, searchingEvents]).then(() => {
        if (!cancelled) setLoading(false)
      })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, query])

  return { results, files, events, projects, loading }
}
