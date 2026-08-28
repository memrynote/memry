/**
 * The two async sources behind the task drawer's "Related" picker.
 *
 * Notes come from full-text search so every note is reachable, not just the
 * most recent page. Canvases are not indexed, so they are matched here.
 */

import { useEffect, useState } from 'react'
import type { FileType } from '@memry/shared/file-types'
import { notesService } from '@/services/notes-service'
import { canvasService } from '@/services/canvas-service'
import { searchService } from '@/services/search-service'
import { createLogger } from '@/lib/logger'
import { extractErrorMessage } from '@/lib/ipc-error'

const log = createLogger('TaskRelatedPicker')

// Mirrors the canvas add-card picker and the note relation picker: long enough
// to coalesce a burst of keystrokes into one request pair, short enough that
// the wait is imperceptible.
const SEARCH_DEBOUNCE_MS = 150

const RECENT_NOTES_LIMIT = 50
const SEARCH_NOTES_LIMIT = 20

export interface RelatedNoteItem {
  kind: 'note'
  id: string
  title: string
  emoji: string | null
  fileType: FileType
}

export interface RelatedCanvasItem {
  kind: 'canvas'
  id: string
  title: string
  icon: string | null
}

/**
 * A note and a canvas can carry the same id, so every related reference is
 * discriminated by `kind` rather than being a bare id.
 */
export type RelatedSearchItem = RelatedNoteItem | RelatedCanvasItem

export interface RelatedSearchState {
  notes: RelatedNoteItem[]
  canvases: RelatedCanvasItem[]
}

const NO_NOTES: RelatedNoteItem[] = []
const NO_CANVASES: RelatedCanvasItem[] = []
const CLOSED: RelatedSearchState = { notes: NO_NOTES, canvases: NO_CANVASES }

export function useRelatedItemSearch(
  open: boolean,
  query: string,
  untitledCanvasLabel: string
): RelatedSearchState {
  const [notes, setNotes] = useState<RelatedNoteItem[]>([])
  const [canvases, setCanvases] = useState<RelatedCanvasItem[]>([])

  useEffect(() => {
    if (!open) return

    let cancelled = false
    const trimmed = query.trim()

    // Only a typed query needs coalescing. Debouncing the empty one would delay
    // the picker's first paint behind results from the previous time it opened.
    const delay = trimmed === '' ? 0 : SEARCH_DEBOUNCE_MS

    const timer = setTimeout(() => {
      // Settled independently: one source failing must not blank the other.
      void (
        trimmed === ''
          ? notesService
              .list({ sortBy: 'modified', sortOrder: 'desc', limit: RECENT_NOTES_LIMIT })
              .then((response) =>
                response.notes.map((note): RelatedNoteItem => ({
                  kind: 'note',
                  id: note.id,
                  title: note.title,
                  emoji: note.emoji ?? null,
                  fileType: (note.fileType ?? 'markdown') as FileType
                }))
              )
          : searchService
              .query({
                text: trimmed,
                types: ['note'],
                tags: [],
                dateRange: null,
                projectId: null,
                folderPath: null,
                limit: SEARCH_NOTES_LIMIT,
                offset: 0
              })
              .then((response) =>
                response.groups
                  .filter((group) => group.type === 'note')
                  .flatMap((group) => group.results)
                  .map((result): RelatedNoteItem => {
                    const metadata = result.metadata.type === 'note' ? result.metadata : null
                    return {
                      kind: 'note',
                      id: result.id,
                      title: result.title,
                      emoji: metadata?.emoji ?? null,
                      fileType: (metadata?.fileType ?? 'markdown') as FileType
                    }
                  })
              )
      ).then(
        (items) => {
          if (!cancelled) setNotes(items)
        },
        (err: unknown) => {
          if (cancelled) return
          log.error('Note search failed:', extractErrorMessage(err))
          setNotes([])
        }
      )

      // Search does not index canvases, so the full metadata list is the whole
      // corpus and the match happens client-side. `list` already drops
      // tombstoned rows. Same compromise use-canvas-tree.ts makes.
      void canvasService.list().then(
        (response) => {
          if (cancelled) return
          const needle = trimmed.toLowerCase()
          setCanvases(
            response.canvases
              .map((canvas): RelatedCanvasItem => ({
                kind: 'canvas',
                id: canvas.id,
                title: canvas.title || untitledCanvasLabel,
                icon: canvas.icon
              }))
              .filter((canvas) => canvas.title.toLowerCase().includes(needle))
          )
        },
        (err: unknown) => {
          if (cancelled) return
          log.error('Canvas search failed:', extractErrorMessage(err))
          setCanvases([])
        }
      )
    }, delay)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, query, untitledCanvasLabel])

  return open ? { notes, canvases } : CLOSED
}
