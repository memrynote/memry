import type { CommandIdsOf } from '@memry/contracts/commands'
import type { ViewScope } from '@memry/contracts/folder-view-api'
import { useT } from '@memry/i18n/renderer'
import { useTabCommands, type CommandImpl } from '@/commands'
import { useCreateNoteInScope } from '@/hooks/use-create-note-in-scope'

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
  const createNote = useCreateNoteInScope(scope)

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
