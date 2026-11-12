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
  const { note, isLoading, refetch } = useNote(noteId)
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
    // The note was read before these listeners went live, and a delete in between sent its
    // event to nobody: read it again once they listen.
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
      () => refetchRef.current()
    )
  }, [noteId])

  return { note: deletedId === noteId ? null : note, isLoading }
}
