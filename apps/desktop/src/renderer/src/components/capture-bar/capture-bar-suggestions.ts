/**
 * The two pools quick-add completes from: the app's tags (for the `#` ghost)
 * and recent notes (for the `[[` picker).
 *
 * Both load the first time the user actually reaches for them, so a surface
 * that never types a marker — and the Inbox, which passes no `quickAdd` at all —
 * pays nothing.
 */

import { useEffect, useRef, useState } from 'react'
import { createLogger } from '@/lib/logger'
import { notesService } from '@/services/notes-service'
import { tagsService } from '@/services/tags-service'

const log = createLogger('CaptureBarSuggestions')

export interface NoteSuggestion {
  id: string
  title: string
}

/** Recent notes for the `[[` picker — the note editor's own list and order. */
export function useNoteSuggestions(enabled: boolean): NoteSuggestion[] {
  const [notes, setNotes] = useState<NoteSuggestion[]>([])
  const requestedRef = useRef(false)

  useEffect(() => {
    if (!enabled || requestedRef.current) return
    requestedRef.current = true

    void (async () => {
      try {
        const result = await notesService.list({ limit: 500, sortBy: 'modified' })
        setNotes(result.notes.map((note) => ({ id: note.id, title: note.title })))
      } catch (error) {
        log.error('Failed to load note suggestions', error)
      }
    })()
  }, [enabled])

  return notes
}

/** The app-wide tag pool, commonest first so the ghost offers the likeliest. */
export function useTagSuggestions(enabled: boolean): string[] {
  const [tags, setTags] = useState<string[]>([])
  const requestedRef = useRef(false)

  useEffect(() => {
    if (!enabled || requestedRef.current) return
    requestedRef.current = true

    void (async () => {
      try {
        const result = await tagsService.getAllWithCounts()
        setTags([...result.tags].sort((a, b) => b.count - a.count).map((tag) => tag.name))
      } catch (error) {
        log.error('Failed to load tag suggestions', error)
      }
    })()
  }, [enabled])

  return tags
}
