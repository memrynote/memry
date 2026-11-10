import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { onNoteOutsideEditKept, type NoteSaveResponse } from '@/services/notes-service'
import { useTabActionsOptional } from '@/contexts/tabs'

/** A note tab's view state that asks the page to open the note's version history once. */
export const VERSION_HISTORY_REQUEST_KEY = 'versionHistory'

/**
 * An outside edit (an agent, another editor) that arrives while typing is not
 * saved yet stays out of the editor, and the typing's save then replaces it on
 * disk. The user is told once that save lands, with a way into version history,
 * when its answer says the core kept the replaced file as a version
 * (`keptReplaced`): a save sent before the editor heard of the edit can replace it
 * with none (#4110). A save that lands before the watcher reports an outside edit
 * leaves the editor no event to hold; the save's answer says so instead
 * (`keptOutsideEdit`). Typing the core holds and the file does
 * not yet wins there too, and the core says so (`notes:outside-edit-kept`). Held edits are kept
 * per note: the save the editor sends when it closes, or moves to another note, answers after
 * the next note's are held (#4088). That save answers after the editor moved on, so the toast
 * names the note, and its action opens that note's history: here while the editor shows it, else
 * in the note's tab.
 */
export function useReplacedOutsideEdit(
  noteId: string | undefined,
  title: string | undefined,
  showVersionHistory: () => void
): {
  /** The outside edit's body that unsaved typing kept out of the editor. */
  held: (noteId: string, content: string) => void
  /** An outside edit of the note is held: a save replaces text the editor never showed. */
  holds: (noteId: string) => boolean
  /** Hands over the note's held outside edit, and holds it no more. */
  take: (noteId: string) => string | undefined
  /**
   * The typing's save answered: tells the user when it replaced a different outside body and the
   * core kept that as a version, and answers whether it did.
   */
  saved: (noteId: string, content: string, result: NoteSaveResponse) => boolean
} {
  const { t } = useT('notes')
  const tabs = useTabActionsOptional()
  const heldRef = useRef(new Map<string, string>())
  const titlesRef = useRef(new Map<string, string>())
  const shownRef = useRef<string | undefined>(undefined)
  const showRef = useRef(showVersionHistory)
  const tabsRef = useRef(tabs)
  const tRef = useRef(t)
  useLayoutEffect(() => {
    showRef.current = showVersionHistory
    tabsRef.current = tabs
    tRef.current = t
    if (noteId && title) titlesRef.current.set(noteId, title)
  })
  useLayoutEffect(() => {
    shownRef.current = noteId
    return () => {
      shownRef.current = undefined
    }
  }, [noteId])

  const toastReplaced = useCallback((id: string): void => {
    const name = titlesRef.current.get(id)
    const showVersions = (): void => {
      if (shownRef.current === id) showRef.current()
      else
        tabsRef.current?.openTab({
          type: 'note',
          title: name ?? '',
          icon: 'file-text',
          path: `/note/${id}`,
          entityId: id,
          isPinned: false,
          isModified: false,
          isPreview: false,
          isDeleted: false,
          viewState: { [VERSION_HISTORY_REQUEST_KEY]: true }
        })
    }
    // One toast per note: every editor of the note open (a note tab, its project's overview,
    // a canvas card) hears the core's event (#4088).
    toast(tRef.current('page.toast.outsideEditReplaced'), {
      id: `outside-edit-replaced:${id}`,
      ...(name && { description: name }),
      duration: 10_000,
      action: { label: tRef.current('page.toast.showVersions'), onClick: showVersions }
    })
  }, [])

  useEffect(() => {
    if (!noteId) return undefined
    return onNoteOutsideEditKept(({ id }) => {
      if (id === noteId) toastReplaced(id)
    })
  }, [noteId, toastReplaced])

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
        if (!result.keptReplaced || (!replaced && !result.keptOutsideEdit)) return false
        toastReplaced(id)
        return true
      }
    }),
    [toastReplaced]
  )
}
