/**
 * The note a portal reads from, kept honest about deletion.
 *
 * `useNote` drops a deleted note from the query cache, but its observer keeps
 * showing the last value, so a portal would go on drawing a note that is gone
 * until it remounted. This tracks the note events for the source: a delete
 * makes the note read as missing at once, and the note coming back (restore,
 * undo of the delete, recreate) or changing reloads it.
 *
 * @module note/content-area/portal/use-portal-source-note
 */

import { useEffect, useRef, useState } from 'react'
import { useNote, type UseNoteResult } from '@/hooks/use-notes-query'
import {
  onNoteCreated,
  onNoteDeleted,
  onNoteMoved,
  onNoteRenamed,
  onNoteUpdated
} from '@/services/notes-service'
import { subscribeToEvents } from '@/services/tauri-event'

export function usePortalSourceNote(noteId: string): Pick<UseNoteResult, 'note' | 'isLoading'> {
  // The first read waits for the listeners below: a delete between the read and the listeners
  // going live sent its event to nobody, and reading again to cover that would open the note
  // twice (`notes_get` counts one `note_opened` per read), once per portal on the page.
  const [listeningId, setListeningId] = useState<string | null>(null)
  const listening = listeningId === noteId
  const { note, isLoading, refetch } = useNote(noteId, { enabled: listening })
  const [deletedId, setDeletedId] = useState<string | null>(null)

  const deletedRef = useRef(false)
  const refetchRef = useRef(refetch)
  useEffect(() => {
    deletedRef.current = deletedId === noteId
    refetchRef.current = refetch
  })

  useEffect(() => {
    // The delete removed the query, so nothing else reloads the note.
    const comesBack = (id: string): void => {
      if (id !== noteId || !deletedRef.current) return
      deletedRef.current = false
      setDeletedId(null)
      refetchRef.current()
    }
    return subscribeToEvents(
      [
        (live) =>
          onNoteDeleted((event) => {
            if (event.id !== noteId) return
            deletedRef.current = true
            setDeletedId(noteId)
          }, live),
        (live) => onNoteCreated((event) => comesBack(event.note.id), live),
        (live) => onNoteUpdated((event) => comesBack(event.id), live),
        (live) => onNoteRenamed((event) => comesBack(event.id), live),
        (live) => onNoteMoved((event) => comesBack(event.id), live)
      ],
      () => setListeningId(noteId)
    )
  }, [noteId])

  return { note: deletedId === noteId ? null : note, isLoading: isLoading || !listening }
}
