import { useCallback } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { extractErrorMessage } from '@/lib/ipc-error'
import { revealNoteInSidebar } from '@/lib/reveal-in-sidebar'
import { setVaultLock } from '@/lib/vault-locks-store'
import { notesService } from '@/services/notes-service'

interface NoteFileActionsInput {
  /** Null while there is no note file yet (a journal day nobody has written). */
  noteId: string | null
  /** The vault-relative path when the caller already holds it; otherwise it is looked up. */
  path?: string
  hasOwnLock: boolean
}

/**
 * What the note and journal overflow menus (and the commands behind them) do to
 * the note's file: copy its path, show it on disk or in the sidebar, open it in
 * its default app, and lock it. A journal entry is a note file, so both pages
 * share these.
 */
export function useNoteFileActions({ noteId, path, hasOwnLock }: NoteFileActionsInput): {
  copyPath: () => Promise<void>
  revealInFinder: () => Promise<void>
  revealInSidebar: () => void
  openExternal: () => Promise<void>
  toggleLock: () => Promise<void>
} {
  const { t } = useT('notes')

  const copyPath = useCallback(async () => {
    if (!noteId) return
    try {
      const resolved = path ?? (await notesService.get(noteId))?.path
      if (!resolved) throw new Error(t('page.toast.copyPathFailed'))
      await navigator.clipboard.writeText(resolved)
      toast.success(t('page.toast.pathCopied'))
    } catch (err) {
      toast.error(extractErrorMessage(err, t('page.toast.copyPathFailed')))
    }
  }, [noteId, path, t])

  const revealInFinder = useCallback(async () => {
    if (!noteId) return
    try {
      await notesService.revealInFinder(noteId)
    } catch (err) {
      toast.error(extractErrorMessage(err, t('page.toast.revealFailed')))
    }
  }, [noteId, t])

  const revealInSidebar = useCallback(() => {
    if (noteId) revealNoteInSidebar(noteId)
  }, [noteId])

  const openExternal = useCallback(async () => {
    if (!noteId) return
    try {
      await notesService.openExternal(noteId)
    } catch (err) {
      toast.error(extractErrorMessage(err, t('page.toast.openExternalFailed')))
    }
  }, [noteId, t])

  const toggleLock = useCallback(async () => {
    if (!noteId) return
    try {
      await setVaultLock('note', noteId, !hasOwnLock)
    } catch (err) {
      toast.error(extractErrorMessage(err, t('vaultLock.toggleFailed')))
    }
  }, [noteId, hasOwnLock, t])

  return { copyPath, revealInFinder, revealInSidebar, openExternal, toggleLock }
}
