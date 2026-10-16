import { useCallback } from 'react'
import { toast } from 'sonner'
import { getI18n } from 'react-i18next'
import { extractErrorMessage } from '@/lib/ipc-error'
import { trackRendererError } from '@/lib/telemetry-diagnostics'
import { createLogger } from '@/lib/logger'
import type { useNoteMutations } from '@/hooks/use-notes-query'
import { useOpenPage } from '@/hooks/use-open-target'
import { notesService } from '@/services/notes-service'
import { revealNoteInSidebar } from '@/lib/reveal-in-sidebar'
import { NEW_NOTE_TITLE, markNewNoteTitlePending } from '@/lib/new-note-title'
import { getDisplayName } from '@/components/notes-tree-utils'

const log = createLogger('Hook:CreateNoteInFolder')

type CreateNote = ReturnType<typeof useNoteMutations>['createNote']['mutateAsync']

/**
 * Create a note in a given folder, with the folder's default template, and
 * open it. The sidebar's "New note" on a folder and the per-folder keyboard
 * shortcuts both go through here.
 */
export function useCreateNoteInFolder(
  createNote: CreateNote
): (folderPath: string) => Promise<void> {
  const { openPage } = useOpenPage()

  return useCallback(
    async (folderPath: string) => {
      try {
        const templateId = await notesService.getFolderTemplate(folderPath)

        const result = await createNote({
          title: NEW_NOTE_TITLE,
          folder: folderPath || undefined,
          template: templateId ?? undefined
        })

        if (result.success && result.note) {
          const newNote = result.note
          markNewNoteTitlePending(newNote.id)
          openPage({
            type: 'note',
            title: getDisplayName(newNote.path),
            icon: 'file-text',
            emoji: newNote.emoji,
            path: `/notes/${newNote.id}`,
            entityId: newNote.id,
            isPinned: false,
            isModified: false,
            isPreview: false,
            isDeleted: false
          })

          // The folder may be shut in the sidebar; the note would then land
          // somewhere invisible.
          revealNoteInSidebar(newNote.id)
        }
      } catch (err) {
        trackRendererError('note_create_failed', err)
        log.error('Failed to create note', err)
        toast.error(
          extractErrorMessage(
            err,
            getI18n().getFixedT(null, 'notes')('phaseI.errors.failedToCreateNote')
          )
        )
      }
    },
    [createNote, openPage]
  )
}
