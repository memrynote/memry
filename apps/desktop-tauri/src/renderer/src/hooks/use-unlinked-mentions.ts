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
import { rereadQueries } from '@/hooks/use-notes-query'
import { subscribeToEvents } from '@/services/tauri-event'

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
    // Once the listeners go live the first read may still be out, and it may have taken its
    // answer before the change: read again, not fold into it (`rereadQueries`).
    const rereadAfterListening = () => rereadQueries(queryClient, unlinkedMentionsKey(noteId))
    // The list was read before these listeners went live, and a change in between sent its event
    // to nobody: read it again once they listen.
    return subscribeToEvents(
      [
        // Any body edit can add or drop a mention; a rename or alias edit of this
        // note changes the names matched.
        (live) =>
          onNoteUpdated((event) => {
            if (event.id === noteId || event.changes.content !== undefined) refresh()
          }, live),
        // A source that gains a link to this note becomes a backlink and leaves the list; one that
        // drops its last link may join it. The index sends this after it committed the links, where
        // a note event comes before.
        (live) =>
          onNoteLinksChanged(({ targetIds }) => {
            if (targetIds.includes(noteId)) refresh()
          }, live),
        (live) => onNoteCreated(refresh, live),
        (live) => onNoteDeleted(refresh, live)
      ],
      rereadAfterListening
    )
  }, [noteId, queryClient])

  return { mentions: query.data ?? EMPTY, isLoading: query.isLoading }
}
