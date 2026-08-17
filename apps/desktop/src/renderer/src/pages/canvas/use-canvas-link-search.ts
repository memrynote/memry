/**
 * The four sources behind the canvas "Link to item" picker.
 *
 * Quick-search covers notes, journals, tasks and inbox items in one call;
 * events come from calendar:search-events; projects and folders are not in the
 * search index at all, so they are listed once and filtered here.
 *
 * Each async source settles independently — one failing must not blank the
 * others, which is the rule the add-card picker already follows.
 */

import { useEffect, useState } from 'react'
import type { CalendarEventSearchItem } from '@memry/contracts/calendar-api'
import type { SearchResultItem } from '@memry/contracts/search-api'
import { calendarService } from '@/services/calendar-service'
import { searchService } from '@/services/search-service'
import { useProjectsList } from '@/hooks/use-projects-list'
import { createLogger } from '@/lib/logger'
import {
  candidatesFromEvents,
  candidatesFromFolders,
  candidatesFromProjects,
  candidatesFromSearch,
  groupCandidates,
  hasAnyCandidate,
  type FolderLike,
  type LinkGroups
} from './canvas-link-candidates'

const log = createLogger('SpatialCanvas')

const SEARCH_DEBOUNCE_MS = 150

export interface CanvasLinkSearch {
  groups: LinkGroups
  hasResults: boolean
  loading: boolean
}

export function useCanvasLinkSearch(open: boolean, query: string): CanvasLinkSearch {
  const [results, setResults] = useState<SearchResultItem[]>([])
  const [events, setEvents] = useState<CalendarEventSearchItem[]>([])
  const [folders, setFolders] = useState<FolderLike[]>([])
  const [loading, setLoading] = useState(false)
  const { projects } = useProjectsList()

  // The folder tree is one vault-wide list, so it is fetched per opening rather
  // than per keystroke; the query filters it locally.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    window.api?.notes
      ?.getFolders?.()
      .then((paths) => {
        if (!cancelled) setFolders(paths)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          log.error('Canvas link picker: folder list failed', err)
          setFolders([])
        }
      })
    return () => {
      cancelled = true
    }
  }, [open])

  // Clearing on an empty query is dropping stale async results, not deriving
  // state from a prop: leaving them would show the previous query's rows, and
  // the in-flight flag has to flip with the query it belongs to.
  /* eslint-disable react-you-might-not-need-an-effect/no-adjust-state-on-prop-change -- see above */
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
      // Every file type: a filed PDF is a legitimate link target here (it opens
      // in the viewer), unlike the add-card picker which can only place notes.
      const searching = searchService.quick(trimmed).then(
        (response) => {
          if (!cancelled) setResults(response.results)
        },
        (err) => {
          if (!cancelled) {
            log.error('Canvas link picker: search failed', err)
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
            log.error('Canvas link picker: event search failed', err)
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
  /* eslint-enable react-you-might-not-need-an-effect/no-adjust-state-on-prop-change */

  const groups = groupCandidates([
    ...candidatesFromSearch(results),
    ...candidatesFromEvents(events),
    ...candidatesFromProjects(projects, query),
    ...candidatesFromFolders(folders, query)
  ])

  return { groups, hasResults: hasAnyCandidate(groups), loading }
}
