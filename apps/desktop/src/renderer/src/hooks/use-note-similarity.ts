/**
 * Similar notes and tag suggestions for one note, from the local embeddings.
 *
 * Both answers are read-only and computed on this device. They refresh when
 * any note's content changes, because a link written in another note removes
 * it from this note's "similar" list, and an edit here moves this note's
 * vector.
 */

import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { NoteTagSuggestion, SimilarNoteItem } from '@memry/contracts/notes-api'
import { useAISettingsContext } from '@/contexts/ai-settings-context'
import { notesService, onNoteUpdated } from '@/services/notes-service'

// Under the `notes` root (notesKeys.all) so a blanket notes invalidation refreshes them too.
export const similarityKeys = {
  similar: (id: string) => ['notes', 'similar', id] as const,
  tagSuggestions: (id: string) => ['notes', 'tag-suggestions', id] as const
}

const STALE_TIME = 30_000

function useRefreshOnContentChange(
  noteId: string | null,
  enabled: boolean,
  key: (id: string) => readonly unknown[]
): void {
  const queryClient = useQueryClient()
  useEffect(() => {
    if (!noteId || !enabled) return
    return onNoteUpdated((event) => {
      if (event.id !== noteId && event.changes.content === undefined) return
      void queryClient.invalidateQueries({ queryKey: key(noteId) })
    })
  }, [noteId, enabled, key, queryClient])
}

/** Nearest notes not already linked. Empty (and not fetched) while embeddings are off. */
export function useSimilarNotes(noteId: string | null): SimilarNoteItem[] {
  const { enabled: embeddingsEnabled } = useAISettingsContext()
  const enabled = embeddingsEnabled && !!noteId
  useRefreshOnContentChange(noteId, enabled, similarityKeys.similar)

  const { data } = useQuery({
    queryKey: similarityKeys.similar(noteId ?? ''),
    queryFn: () => notesService.getSimilar(noteId as string),
    enabled,
    staleTime: STALE_TIME
  })
  return enabled && data?.status === 'ready' ? data.notes : []
}

/** Tags shared by the note's neighbours. `enabled: false` skips the lookup entirely. */
export function useTagSuggestions(
  noteId: string | null,
  { enabled: wanted = true }: { enabled?: boolean } = {}
): NoteTagSuggestion[] {
  const { enabled: embeddingsEnabled } = useAISettingsContext()
  const enabled = embeddingsEnabled && wanted && !!noteId
  useRefreshOnContentChange(noteId, enabled, similarityKeys.tagSuggestions)

  const { data } = useQuery({
    queryKey: similarityKeys.tagSuggestions(noteId ?? ''),
    queryFn: () => notesService.getTagSuggestions(noteId as string),
    enabled,
    staleTime: STALE_TIME
  })
  return enabled && data?.status === 'ready' ? data.tags : []
}
