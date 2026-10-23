import {
  Pencil,
  Trash2,
  ExternalLink,
  FolderOpen,
  FilePlus,
  LayoutTemplate,
  Save,
  X,
  Smile
} from '@/lib/icons'
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu'
import { BookmarkMenuItem } from '@/components/sidebar/bookmark-menu-item'
import { VaultLockMenuItem } from '@/components/sidebar/vault-lock-menu-item'
import { OpenTargetMenuItems } from '@/components/sidebar/open-target-menu-items'
import { ShowTasksMenuItem } from '@/components/sidebar/show-tasks-menu-item'
import { noteTabData } from '@/lib/sidebar-tab-data'
import { useFileActionLabels } from '@/hooks/use-file-action-labels'
import type { NoteListItem } from '@/hooks/use-notes-query'
import { useT } from '@memry/i18n/renderer'

type NoteAction = (note: NoteListItem) => void

export interface NoteContextMenuItemsProps {
  note: NoteListItem
  onRename: NoteAction
  onApplyTemplate: NoteAction
  onSaveAsTemplate: NoteAction
  onNewNoteFromNote: NoteAction
  onSetIcon: NoteAction
  onRemoveIcon: NoteAction
  onOpenExternal: NoteAction
  onRevealInFinder: NoteAction
  onDelete: NoteAction
}

/** Context-menu rows for a single note in the sidebar tree. */
export function NoteContextMenuItems({
  note,
  onRename,
  onApplyTemplate,
  onSaveAsTemplate,
  onNewNoteFromNote,
  onSetIcon,
  onRemoveIcon,
  onOpenExternal,
  onRevealInFinder,
  onDelete
}: NoteContextMenuItemsProps): React.JSX.Element {
  const { t } = useT('notes')
  const { t: tCommon } = useT('common')
  const fileActions = useFileActionLabels()
  // Journal entries belong to the Journal: note-only actions (templates,
  // icons, bookmarks) would write to the journal as if it were a note.
  const isJournal = !!note.journalDate

  return (
    <>
      <OpenTargetMenuItems tab={noteTabData(note)} />
      {(note.fileType ?? 'markdown') === 'markdown' && (
        <ShowTasksMenuItem location={{ noteId: note.id }} />
      )}
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => onRename(note)}>
        <Pencil className="me-2 h-4 w-4" />
        {t('tree.actions.rename')}
      </ContextMenuItem>
      {!isJournal && (
        <>
          <ContextMenuItem onClick={() => onApplyTemplate(note)}>
            <LayoutTemplate className="me-2 h-4 w-4" />
            {t('tree.actions.applyTemplate')}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => onSaveAsTemplate(note)}>
            <Save className="me-2 h-4 w-4" />
            {t('tree.actions.saveAsTemplate')}
          </ContextMenuItem>
          {(note.fileType ?? 'markdown') === 'markdown' && (
            <ContextMenuItem onClick={() => onNewNoteFromNote(note)}>
              <FilePlus className="me-2 h-4 w-4" />
              {t('newNoteFromNote.action')}
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => onSetIcon(note)}>
            <Smile className="me-2 h-4 w-4" />
            {t('tree.actions.setIcon')}
          </ContextMenuItem>
          {note.emoji && (
            <ContextMenuItem onClick={() => onRemoveIcon(note)}>
              <X className="me-2 h-4 w-4" />
              {t('tree.actions.removeIcon')}
            </ContextMenuItem>
          )}
        </>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => onOpenExternal(note)}>
        <ExternalLink className="me-2 h-4 w-4" />
        {t('tree.actions.openExternal')}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => onRevealInFinder(note)}>
        <FolderOpen className="me-2 h-4 w-4" />
        {fileActions.revealInFolder}
      </ContextMenuItem>
      <ContextMenuSeparator />
      {!isJournal && (
        <>
          <BookmarkMenuItem itemType="note" itemId={note.id} />
          <VaultLockMenuItem kind="note" target={note.id} />
          <ContextMenuSeparator />
        </>
      )}
      <ContextMenuItem variant="destructive" onClick={() => onDelete(note)}>
        <Trash2 className="me-2 h-4 w-4" />
        {tCommon('button.delete')}
      </ContextMenuItem>
    </>
  )
}
