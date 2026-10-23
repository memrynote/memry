import { Folder, Loader2 } from '@/lib/icons'
import type { NoteListItem } from '@/hooks/use-notes-query'
import { getDisplayName } from '@/components/notes-tree-utils'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { TemplateSelector } from '@/components/note/template-selector'
import { DeleteNoteTasksOption, useNoteTasksChoice } from '@/components/note/delete-note-tasks'
import { useT } from '@memry/i18n/renderer'
import { containsJournalFolder } from '@/lib/journal-path'
import type { JournalChangeKind } from '@/hooks/use-note-tree-actions'

// ============================================================================
// Delete Confirmation Dialog
// ============================================================================

interface NoteTreeDeleteDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  notesToDelete: NoteListItem[]
  foldersToDelete: string[]
  isDeleting: boolean
  /** `taskIds`: the notes' tasks the user chose to delete with them, or none. */
  onConfirm: (taskIds: string[]) => void
  /** The vault's journal folder, to warn when a deleted folder holds it. */
  journalFolder?: string | null
}

export function NoteTreeDeleteDialog({
  open,
  onOpenChange,
  notesToDelete,
  foldersToDelete,
  isDeleting,
  onConfirm,
  journalFolder = null
}: NoteTreeDeleteDialogProps) {
  const { t } = useT('notes')
  const { t: tCommon } = useT('common')
  const totalItems = notesToDelete.length + foldersToDelete.length
  const tasksChoice = useNoteTasksChoice(
    open,
    notesToDelete.map((note) => note.id),
    foldersToDelete
  )

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {totalItems === 1
              ? foldersToDelete.length === 1
                ? t('tree.deleteDialog.folderTitle')
                : t('tree.deleteDialog.noteTitle')
              : t('tree.deleteDialog.itemsTitle', { count: totalItems })}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="text-sm text-muted-foreground">
              <DeleteDialogBody notesToDelete={notesToDelete} foldersToDelete={foldersToDelete} />
              {journalFolder &&
                foldersToDelete.some((folder) => containsJournalFolder(folder, journalFolder)) && (
                  <p className="mt-2 font-medium text-destructive">
                    {t('tree.deleteDialog.journalFolderWarning')}
                  </p>
                )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <DeleteNoteTasksOption choice={tasksChoice} disabled={isDeleting} />
        <AlertDialogFooter>
          <AlertDialogCancel>{tCommon('button.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => onConfirm(tasksChoice.taskIdsToDelete)}
            disabled={isDeleting}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isDeleting ? (
              <>
                <Loader2 className="me-2 h-4 w-4 animate-spin" />
                {t('tree.deleteDialog.deleting')}
              </>
            ) : totalItems === 1 ? (
              tCommon('button.delete')
            ) : (
              t('tree.deleteDialog.deleteCount', { count: totalItems })
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function DeleteDialogBody({
  notesToDelete,
  foldersToDelete
}: {
  notesToDelete: NoteListItem[]
  foldersToDelete: string[]
}) {
  const { t } = useT('notes')
  const totalItems = notesToDelete.length + foldersToDelete.length

  if (totalItems === 1) {
    if (foldersToDelete.length === 1) {
      const folderName = foldersToDelete[0].split('/').pop() || foldersToDelete[0]
      return <>{t('tree.deleteDialog.folderBody', { name: folderName })}</>
    }
    return (
      <>{t('tree.deleteDialog.noteBody', { name: getDisplayName(notesToDelete[0]?.path || '') })}</>
    )
  }

  return (
    <>
      {t('tree.deleteDialog.itemsBody', { count: totalItems })}
      <ul className="mt-2 max-h-32 overflow-y-auto text-sm list-disc list-inside">
        {foldersToDelete.slice(0, 3).map((folderPath) => (
          <li key={`folder-${folderPath}`} className="flex items-center gap-1">
            <Folder className="h-3 w-3 inline" />
            {folderPath.split('/').pop() || folderPath} ({t('tree.deleteDialog.folderSuffix')})
          </li>
        ))}
        {notesToDelete.slice(0, 5 - Math.min(foldersToDelete.length, 3)).map((note) => (
          <li key={note.id}>{getDisplayName(note.path)}</li>
        ))}
        {totalItems > 5 && (
          <li className="text-muted-foreground">
            {t('tree.deleteDialog.moreItems', { count: totalItems - 5 })}
          </li>
        )}
      </ul>
    </>
  )
}

// ============================================================================
// Journal Change Dialog
// ============================================================================

interface NoteTreeJournalChangeDialogProps {
  kind: JournalChangeKind | null
  onResolve: (confirmed: boolean) => void
}

/**
 * Asked before a rename or move turns journal entries into notes or notes into
 * journal entries: either one deletes the old item and creates a new one on
 * every synced device.
 */
export function NoteTreeJournalChangeDialog({ kind, onResolve }: NoteTreeJournalChangeDialogProps) {
  const { t } = useT('notes')
  const { t: tCommon } = useT('common')

  return (
    <AlertDialog open={kind !== null} onOpenChange={(open) => !open && onResolve(false)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {kind === 'join'
              ? t('tree.journalChange.joinTitle')
              : t('tree.journalChange.leaveTitle')}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {kind === 'join' ? t('tree.journalChange.joinBody') : t('tree.journalChange.leaveBody')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{tCommon('button.cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={() => onResolve(true)}>
            {t('tree.journalChange.confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// ============================================================================
// Template Selector Dialog
// ============================================================================

interface NoteTreeTemplateSelectorProps {
  isOpen: boolean
  onClose: () => void
  onSelect: (templateId: string | null) => void
}

export function NoteTreeTemplateSelector({
  isOpen,
  onClose,
  onSelect
}: NoteTreeTemplateSelectorProps) {
  return <TemplateSelector isOpen={isOpen} onClose={onClose} onSelect={onSelect} />
}
