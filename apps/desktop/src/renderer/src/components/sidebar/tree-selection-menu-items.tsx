import { FolderInput, FolderPlus, Star, Trash2 } from '@/lib/icons'
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu'
import { useT } from '@memry/i18n/renderer'

export interface TreeSelectionActions {
  onCreateFolderWithSelection: () => void
  onMoveSelection: () => void
  onBookmarkSelection: () => void
  onDeleteSelection: () => void
}

interface TreeSelectionMenuItemsProps {
  count: number
  actions: TreeSelectionActions
}

/** Context-menu rows for a sidebar row that is part of a multi-selection. */
export function TreeSelectionMenuItems({
  count,
  actions
}: TreeSelectionMenuItemsProps): React.JSX.Element {
  const { t } = useT('notes')

  return (
    <>
      <ContextMenuItem onClick={actions.onCreateFolderWithSelection}>
        <FolderPlus className="me-2 h-4 w-4" />
        {t('tree.actions.newFolderWithSelection', { count })}
      </ContextMenuItem>
      <ContextMenuItem onClick={actions.onMoveSelection}>
        <FolderInput className="me-2 h-4 w-4" />
        {t('tree.actions.moveSelectedItems', { count })}
      </ContextMenuItem>
      <ContextMenuItem onClick={actions.onBookmarkSelection}>
        <Star className="me-2 h-4 w-4" />
        {t('tree.actions.bookmarkSelectedItems', { count })}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem variant="destructive" onClick={actions.onDeleteSelection}>
        <Trash2 className="me-2 h-4 w-4" />
        {t('tree.actions.deleteSelectedItems', { count })}
      </ContextMenuItem>
    </>
  )
}
