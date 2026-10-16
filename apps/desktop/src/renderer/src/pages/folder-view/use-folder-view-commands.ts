import { useCallback } from 'react'
import type { CommandIdsOf } from '@memry/contracts/commands'
import type { ViewScope } from '@memry/contracts/folder-view-api'
import { useT } from '@memry/i18n/renderer'
import { useTabCommands, type CommandImpl } from '@/commands'
import { useNoteMutations } from '@/hooks/use-notes-query'
import { useOpenPage } from '@/hooks/use-open-target'
import { createLogger } from '@/lib/logger'
import { NEW_NOTE_TITLE, markNewNoteTitlePending } from '@/lib/new-note-title'

const log = createLogger('Page:FolderView')

export type FolderCommandId = CommandIdsOf<'folder'>

interface FolderCommandInput {
  scope: ViewScope
  openSearch: () => void
  /** Open the page's rename and delete dialogs. The tag is deleted only after its confirm. */
  openTagRename: () => void
  openTagDelete: () => void
}

/**
 * The owner of every `folder.*` command, registered per tab. The header's "New
 * note" button and the empty states run `createNote`, the same function the
 * palette command runs. The tag commands are available only under a tag scope,
 * where the header shows the tag's `...` menu.
 */
export function useFolderViewCommands({
  scope,
  openSearch,
  openTagRename,
  openTagDelete
}: FolderCommandInput): { createNote: () => Promise<void> } {
  const { t } = useT('notes')
  // Creates through the mutation so a folder's template is applied.
  const { createNote: createNoteMutation } = useNoteMutations()
  // Plain opens honour the "clicking a page opens a new tab" preference (#1644).
  const { openPage } = useOpenPage()

  /**
   * Folder scope: creates it in the current folder (template auto-applied
   * from .folder.md if one exists). Tag scope: creates it in the default
   * folder with the scoped tag already applied, so the new row appears in
   * the view the user is standing in.
   */
  const createNote = useCallback(async () => {
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

  const isTag = scope.kind === 'tag'
  const commands: Record<FolderCommandId, CommandImpl> = {
    'folder.newNote': { label: t('phaseF.pagesFolderView.createNewNote'), run: createNote },
    'folder.search': {
      label: t('phaseF.componentsFolderViewFolderViewToolbar.searchNotes'),
      run: openSearch
    },
    'folder.renameTag': {
      label: t('phaseF.componentsSidebarTagRenameDialog.renameTag'),
      enabled: isTag,
      run: openTagRename
    },
    'folder.deleteTag': {
      label: t('phaseF.componentsSidebarTagDetailView.deleteTag'),
      enabled: isTag,
      run: openTagDelete
    }
  }

  useTabCommands('folder', commands)
  return { createNote }
}
