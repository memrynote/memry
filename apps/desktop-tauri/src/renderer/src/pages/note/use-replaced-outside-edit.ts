import { useLayoutEffect, useMemo, useRef } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import type { NoteUpdateResponse } from '@memry/contracts/notes-api'

/**
 * An outside edit (an agent, another editor) that arrives while typing is not
 * saved yet stays out of the editor, and the typing's save then replaces it on
 * disk. The core keeps the replaced file as a version, so the user is told once
 * that save lands, with a way into version history. A save that lands before
 * the watcher reports an outside edit leaves the editor no event to hold; the
 * save's answer says so instead (`keptOutsideEdit`).
 */
export function useReplacedOutsideEdit(showVersionHistory: () => void): {
  /** The outside edit's body that unsaved typing kept out of the editor. */
  held: (noteId: string, content: string) => void
  /** The typing's save answered: tells the user when it replaced a different outside body. */
  saved: (noteId: string, content: string, result: NoteUpdateResponse) => void
} {
  const { t } = useT('notes')
  const heldRef = useRef<{ noteId: string; content: string } | null>(null)
  const showRef = useRef(showVersionHistory)
  const tRef = useRef(t)
  useLayoutEffect(() => {
    showRef.current = showVersionHistory
    tRef.current = t
  })

  return useMemo(
    () => ({
      held: (noteId, content) => {
        heldRef.current = { noteId, content }
      },
      saved: (noteId, content, result) => {
        const held = heldRef.current
        heldRef.current = null
        if (!result.success) return
        const replaced = held?.noteId === noteId && held.content !== content
        if (!replaced && !result.keptOutsideEdit) return
        toast(tRef.current('page.toast.outsideEditReplaced'), {
          action: {
            label: tRef.current('page.toast.showVersions'),
            onClick: () => showRef.current()
          }
        })
      }
    }),
    []
  )
}
