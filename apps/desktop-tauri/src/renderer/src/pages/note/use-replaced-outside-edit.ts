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
 * not yet wins there too, and the core says so (`notes:outside-edit-kept`). Held edits are kept
 * per note: the save the editor sends when it closes, or moves to another note, answers after
 * the next note's are held (#4088).
 */
export function useReplacedOutsideEdit(
  noteId: string | undefined,
  showVersionHistory: () => void
): {
  /** The outside edit's body that unsaved typing kept out of the editor. */
  held: (noteId: string, content: string) => void
  /** An outside edit of the note is held: a save replaces text the editor never showed. */
  holds: (noteId: string) => boolean
  /** Hands over the note's held outside edit, and holds it no more. */
  take: (noteId: string) => string | undefined
  /**
   * The typing's save answered: tells the user when it replaced a different outside body, and
   * answers whether it did.
   */
  saved: (noteId: string, content: string, result: NoteUpdateResponse) => boolean
} {
  const { t } = useT('notes')
  const heldRef = useRef(new Map<string, string>())
  const showRef = useRef(showVersionHistory)
  const tRef = useRef(t)
  useLayoutEffect(() => {
    showRef.current = showVersionHistory
    tRef.current = t
  })
  useEffect(() => {
    if (!noteId) return undefined
    return onNoteOutsideEditKept(({ id }) => {
      if (id === noteId) toastReplaced(id, tRef.current, showRef.current)
    })
  }, [noteId])

  return useMemo(
    () => ({
      held: (id, content) => {
        heldRef.current.set(id, content)
      },
      holds: (id) => heldRef.current.has(id),
      take: (id) => {
        const held = heldRef.current.get(id)
        heldRef.current.delete(id)
        return held
      },
      saved: (id, content, result) => {
        // A failed save replaced nothing; the held edit waits for the save that lands.
        if (!result.success) return false
        const held = heldRef.current.get(id)
        heldRef.current.delete(id)
        const replaced = held !== undefined && held !== content
        if (!replaced && !result.keptOutsideEdit) return false
        toastReplaced(id, tRef.current, showRef.current)
        return true
      }
    }),
    []
  )
}

// One toast per note: every editor of the note open (a note tab, its project's overview, a canvas
// card) hears the core's event (#4088).
function toastReplaced(
  noteId: string,
  t: (key: string) => string,
  showVersionHistory: () => void
): void {
  toast(t('page.toast.outsideEditReplaced'), {
    id: `outside-edit-replaced:${noteId}`,
    duration: 10_000,
    action: {
      label: t('page.toast.showVersions'),
      onClick: () => showVersionHistory()
    }
  })
}
