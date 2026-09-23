import { useCallback } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { notesService } from '@/services/notes-service'
import { useOpenPage } from '@/hooks/use-open-target'
import { revealNoteInSidebar } from '@/lib/reveal-in-sidebar'
import { extractErrorMessage, unwrapIpcResult } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { extractFolderFromPath, getDisplayName } from '@/components/notes-tree-utils'

const log = createLogger('Hook:CreateNoteFromNote')

/**
 * Sends no template id so the folder's default template still applies: the
 * copied values win over the template's and its body fills the empty body. An
 * icon-less source sends no icon so the template's icon can fill that gap too.
 */
export function useCreateNoteFromNote(): (sourceId: string) => Promise<void> {
  const { t } = useT('notes')
  const { openPage } = useOpenPage()

  return useCallback(
    async (sourceId: string) => {
      const failed = t('phaseI.errors.failedToCreateNote')
      try {
        const source = await notesService.get(sourceId)
        if (!source) throw new Error(failed)

        const folder = extractFolderFromPath(source.path)
        const response = await notesService.create({
          title: 'Untitled',
          content: '',
          folder: folder || undefined,
          tags: source.tags,
          properties: source.properties,
          emoji: source.emoji ?? undefined
        })
        const newNote = unwrapIpcResult(response, failed).note
        if (!newNote) throw new Error(failed)

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
        revealNoteInSidebar(newNote.id, { rename: true })
        toast.success(
          t('newNoteFromNote.created', {
            tagCount: source.tags.length,
            propertyCount: Object.keys(source.properties).length,
            source: source.title
          })
        )
      } catch (err) {
        log.error('Failed to create note from note', err)
        toast.error(extractErrorMessage(err, failed))
      }
    },
    [t, openPage]
  )
}
