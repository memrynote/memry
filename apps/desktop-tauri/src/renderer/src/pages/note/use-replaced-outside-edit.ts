import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import type { NoteUpdateResponse } from '@memry/contracts/notes-api'
import { onNoteOutsideEditKept } from '@/services/notes-service'

/**
 * An outside edit (an agent, another editor) that arrives while typing is not
 * saved yet stays out of the editor, and the typing's save then replaces it on
 * disk. The core keeps the replaced file as a version, so the user is told once
 * that save lands, with a way into version history. A save that lands before
 * the watcher reports an outside edit leaves the editor no event to hold; the
 * save's answer says so instead (`keptOutsideEdit`). Typing the core holds and the file does
 * not yet wins there too, and the core says so (`notes:outside-edit-kept`).
 */
export function useReplacedOutsideEdit(
  noteId: string | undefined,
  showVersionHistory: () => void
): {
  /** The outside edit's body that unsaved typing kept out of the editor. */
  held: (noteId: string, content: string) => void
  /**
   * The typing's save answered: tells the user when it replaced a different outside body, and
   * answers whether it did.
   */
  saved: (noteId: string, content: string, result: NoteUpdateResponse) => boolean
} {
  const { t } = useT('notes')
  const heldRef = useRef<{ noteId: string; content: string } | null>(null)
  const showRef = useRef(showVersionHistory)
  const tRef = useRef(t)
  useLayoutEffect(() => {
    showRef.current = showVersionHistory
    tRef.current = t
  })
  // An edit held for the note the page showed before is not this note's.
  useLayoutEffect(() => {
    if (heldRef.current?.noteId !== noteId) heldRef.current = null
  }, [noteId])
  useEffect(() => {
    if (!noteId) return undefined
    return onNoteOutsideEditKept(({ id }) => {
      if (id === noteId) toastReplaced(tRef.current, showRef.current)
    })
  }, [noteId])

  return useMemo(
    () => ({
      held: (id, content) => {
        heldRef.current = { noteId: id, content }
      },
      saved: (id, content, result) => {
        // A failed save replaced nothing; the held edit waits for the save that lands.
        if (!result.success) return false
        const held = heldRef.current
        heldRef.current = null
        const replaced = held?.noteId === id && held.content !== content
        if (!replaced && !result.keptOutsideEdit) return false
        toastReplaced(tRef.current, showRef.current)
        return true
      }
    }),
    []
  )
}

function toastReplaced(t: (key: string) => string, showVersionHistory: () => void): void {
  toast(t('page.toast.outsideEditReplaced'), {
    duration: 10_000,
    action: {
      label: t('page.toast.showVersions'),
      onClick: () => showVersionHistory()
    }
  })
}
