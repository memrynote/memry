import { useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import { getI18n } from 'react-i18next'
import { useKeyboardShortcuts, chordAllowedInInput } from '@/hooks/use-keyboard-shortcuts-base'
import { useNoteMutations } from '@/hooks/use-notes-query'
import { useCreateNoteInFolder } from '@/hooks/use-create-note-in-folder'
import { useFolderNoteShortcuts } from '@/lib/shortcut-bindings'
import { useSettingsModal } from '@/contexts/settings-modal-context'
import { notesService } from '@/services/notes-service'
import { extractErrorMessage } from '@/lib/ipc-error'

/**
 * Settings → Shortcuts → "New note in folder". Each chord creates a note in its
 * folder and opens it. Creating a note in a missing folder would quietly make
 * the folder again, so a shortcut whose folder is gone says so instead.
 */
export function useFolderNoteShortcutsRuntime(): void {
  const entries = useFolderNoteShortcuts()
  const createNoteInFolder = useCreateNoteInFolder(useNoteMutations().createNote.mutateAsync)
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
              onClick: () => openSettings('shortcuts')
            }
          })
          return
        }
      } catch (err) {
        toast.error(extractErrorMessage(err, t('shortcuts.folderNotes.foldersLoadFailed')))
        return
      }
      await createNoteInFolder(folder)
    },
    [createNoteInFolder, openSettings]
  )

  const shortcuts = useMemo(
    () =>
      entries.map(({ folder, binding }) => ({
        key: binding.key,
        modifiers: binding.modifiers,
        allowInInput: chordAllowedInInput(binding),
        description: folder,
        action: () => void run(folder)
      })),
    [entries, run]
  )

  useKeyboardShortcuts(shortcuts)
}
