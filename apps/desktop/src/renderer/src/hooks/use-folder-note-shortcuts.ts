import { useCallback, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { getI18n } from 'react-i18next'
import { registerFolderNoteRunner } from '@/commands'
import { useCreateNewNote } from '@/hooks/use-create-new-note'
import { useSettingsModal } from '@/contexts/settings-modal-context'
import { notesService } from '@/services/notes-service'
import { extractErrorMessage } from '@/lib/ipc-error'

/**
 * Settings → Shortcuts → "New note in folder". The command dispatcher matches the
 * chord (see `resolveFolderChord`) and this is what it runs for the folder: create
 * a note there and open it. Creating a note in a missing folder would quietly make
 * the folder again, so a shortcut whose folder is gone says so instead.
 */
export function useFolderNoteShortcutsRuntime(): void {
  const createNewNote = useCreateNewNote()
  const { open: openSettings } = useSettingsModal()

  const run = useCallback(
    async (folder: string) => {
      const t = getI18n().getFixedT(null, 'settings')
      try {
        const folders = await notesService.getFolders()
        if (!folders.some((f) => f.path === folder)) {
          toast.error(t('shortcuts.folderNotes.missingToast', { folder }), {
            action: {
              label: t('shortcuts.folderNotes.missingToastAction'),
              onClick: () => {
                openSettings('shortcuts')
              }
            }
          })
          return
        }
      } catch (err) {
        toast.error(extractErrorMessage(err, t('shortcuts.folderNotes.foldersLoadFailed')))
        return
      }
      await createNewNote({ folder })
    },
    [createNewNote, openSettings]
  )

  // The dispatcher registers once and calls whichever `run` is latest.
  const runRef = useRef(run)
  useEffect(() => {
    runRef.current = run
  }, [run])
  useEffect(() => registerFolderNoteRunner((folder) => void runRef.current(folder)), [])
}
