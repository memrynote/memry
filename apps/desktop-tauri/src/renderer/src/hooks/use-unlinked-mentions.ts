import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { UnlinkedMention } from '@memry/contracts/notes-api'
import {
  notesService,
  onNoteCreated,
  onNoteDeleted,
  onNoteLinksChanged,
  onNoteUpdated
} from '@/services/notes-service'

const EMPTY: UnlinkedMention[] = []

// Under the `notes` root so a whole-notes invalidation reaches it too.
export const unlinkedMentionsKey = (noteId: string) =>
  ['notes', 'unlinked-mentions', noteId] as const

/** Notes that mention `noteId`'s title or an alias without linking to it (#3320). */
export function useUnlinkedMentionsQuery(noteId: string | null, enabled: boolean) {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: unlinkedMentionsKey(noteId ?? ''),
    queryFn: () => notesService.getUnlinkedMentions(noteId!),
    enabled: enabled && !!noteId
  })

  useEffect(() => {
    if (!noteId) return undefined
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: unlinkedMentionsKey(noteId) })
    }
    // Any body edit can add or drop a mention; a rename or alias edit of this
    // note changes the names matched.
    const unsubUpdated = onNoteUpdated((event) => {
      if (event.id === noteId || event.changes.content !== undefined) refresh()
    })
    // A source that gains a link to this note becomes a backlink and leaves the list; one that
    // drops its last link may join it. The index sends this after it committed the links, where
    // a note event comes before.
    const unsubLinks = onNoteLinksChanged(({ targetIds }) => {
      if (targetIds.includes(noteId)) refresh()
    })
    const unsubCreated = onNoteCreated(refresh)
    const unsubDeleted = onNoteDeleted(refresh)
    return () => {
      unsubUpdated()
      unsubLinks()
      unsubCreated()
      unsubDeleted()
    }
  }, [noteId, queryClient])

  return { mentions: query.data ?? EMPTY, isLoading: query.isLoading }
}
