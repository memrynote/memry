import { useCallback } from 'react'
import type { ViewScope } from '@memry/contracts/folder-view-api'
import { useNoteMutations } from '@/hooks/use-notes-query'
import { useOpenPage } from '@/hooks/use-open-target'
import { createLogger } from '@/lib/logger'
import { NEW_NOTE_TITLE, markNewNoteTitlePending } from '@/lib/new-note-title'

const log = createLogger('CreateNoteInScope')

/**
 * Creates a note where a folder or tag view will list it, then opens it. The
 * folder page's "New note" and a view block's "New note" both run this.
 *
 * Folder scope: creates it in the folder (template auto-applied from
 * .folder.md if one exists). Tag scope: creates it in the default folder with
 * the scoped tag already applied, so the new row appears in the view.
 */
export function useCreateNoteInScope(scope: ViewScope): () => Promise<void> {
  // Creates through the mutation so a folder's template is applied.
  const { createNote: createNoteMutation } = useNoteMutations()
  // Plain opens honour the "clicking a page opens a new tab" preference (#1644).
  const { openPage } = useOpenPage()

  return useCallback(async () => {
    try {
      const result = await createNoteMutation.mutateAsync(
        scope.kind === 'folder'
          ? { title: NEW_NOTE_TITLE, folder: scope.path || undefined }
          : { title: NEW_NOTE_TITLE, tags: [scope.tag] }
      )

      if (result.success && result.note) {
        markNewNoteTitlePending(result.note.id)
        openPage({
          type: 'note',
          title: result.note.title,
          icon: 'file-text',
          emoji: result.note.emoji,
          path: `/notes/${result.note.id}`,
          entityId: result.note.id,
          isPinned: false,
          isModified: false,
          isPreview: false,
          isDeleted: false
        })
      }
    } catch (err) {
      log.error('Failed to create note:', err)
    }
  }, [createNoteMutation, scope, openPage])
}
