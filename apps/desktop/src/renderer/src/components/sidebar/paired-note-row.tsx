import { ArrowRight, ChevronsDown, ChevronsUp, FilePlus, FolderPlus } from '@/lib/icons'
import { useTree } from '@/components/kibo-ui/tree'
import { IconPickerButton } from '@/components/icon-picker-button'
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu'
import { getFileIcon } from '@/components/notes-tree-utils'
import type { NoteListItem } from '@/hooks/use-notes-query'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'

// A folder `X/` whose sibling note `X.md` the sidebar draws on the same row
// (`pairFolderNotes`). The row shows the note's icon, its label opens the note,
// and only the chevron opens the folder. Both sidebar trees use these parts.

interface PairedNoteIconProps {
  note: NoteListItem
  isExpanded: boolean
  hasChildren: boolean
  onToggleExpand: () => void
  onIconChange: (icon: string | null) => void
  pickerOpen: boolean
  onPickerOpenChange: (open: boolean) => void
}

/**
 * The note's icon behind the folder's chevron. The chevron toggles the folder
 * itself and keeps the click from the row, because a click on the row opens
 * the note.
 */
export function PairedNoteIcon({
  note,
  isExpanded,
  hasChildren,
  onToggleExpand,
  onIconChange,
  pickerOpen,
  onPickerOpenChange
}: PairedNoteIconProps): React.JSX.Element {
  const { t } = useT('notes')
  const { t: tCommon } = useT('common')

  const chevron = hasChildren ? (
    <button
      type="button"
      className="flex h-4 w-4 items-center justify-center cursor-pointer rounded"
      aria-expanded={isExpanded}
      aria-label={
        isExpanded
          ? tCommon('phaseF.componentsFolderIconButton.collapseFolder')
          : tCommon('phaseF.componentsFolderIconButton.expandFolder')
      }
      onClick={(e) => {
        e.stopPropagation()
        onToggleExpand()
      }}
    >
      <ArrowRight
        className={cn(
          'h-3 w-3 text-muted-foreground/60 transition-transform',
          isExpanded && 'rotate-90'
        )}
      />
    </button>
  ) : (
    <div className="h-4 w-4" />
  )

  return (
    <IconPickerButton
      leading={chevron}
      hasIcon={!!note.emoji}
      onIconChange={onIconChange}
      ariaLabel={t('tree.actions.setIcon')}
      pickerOpen={pickerOpen}
      onPickerOpenChange={onPickerOpenChange}
    >
      {getFileIcon(note)}
    </IconPickerButton>
  )
}

/** `PairedNoteIcon` for the plain tree, which keeps expansion in its provider. */
export function TreePairedNoteIcon({
  nodeId,
  ...props
}: Omit<PairedNoteIconProps, 'isExpanded' | 'onToggleExpand'> & {
  nodeId: string
}): React.JSX.Element {
  const { expandedIds, toggleExpanded } = useTree()
  return (
    <PairedNoteIcon
      {...props}
      isExpanded={expandedIds.has(nodeId)}
      onToggleExpand={() => toggleExpanded(nodeId)}
    />
  )
}

interface PairedFolderMenuItemsProps {
  folderPath: string
  onCreateNote: (folderPath: string) => void
  onCreateFolder: (folderPath: string) => void
  onSetSubtreeExpanded: (folderPath: string, expanded: boolean) => void
}

/** The folder's half of the row's context menu: what goes inside it. */
export function PairedFolderMenuItems({
  folderPath,
  onCreateNote,
  onCreateFolder,
  onSetSubtreeExpanded
}: PairedFolderMenuItemsProps): React.JSX.Element {
  const { t } = useT('notes')
  return (
    <>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => onCreateNote(folderPath)}>
        <FilePlus className="me-2 h-4 w-4" />
        {t('tree.actions.newNote')}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => onCreateFolder(folderPath)}>
        <FolderPlus className="me-2 h-4 w-4" />
        {t('tree.actions.newFolder')}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => onSetSubtreeExpanded(folderPath, true)}>
        <ChevronsUp className="me-2 h-4 w-4" />
        {t('tree.actions.expandSubfolders')}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => onSetSubtreeExpanded(folderPath, false)}>
        <ChevronsDown className="me-2 h-4 w-4" />
        {t('tree.actions.collapseSubfolders')}
      </ContextMenuItem>
    </>
  )
}
