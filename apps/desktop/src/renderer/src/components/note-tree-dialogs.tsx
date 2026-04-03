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

// ============================================================================
// Delete Confirmation Dialog
// ============================================================================

interface NoteTreeDeleteDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  notesToDelete: NoteListItem[]
  foldersToDelete: string[]
  isDeleting: boolean
  onConfirm: () => void
}

export function NoteTreeDeleteDialog({
  open,
  onOpenChange,
  notesToDelete,
  foldersToDelete,
  isDeleting,
  onConfirm
}: NoteTreeDeleteDialogProps) {
  const totalItems = notesToDelete.length + foldersToDelete.length

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {totalItems === 1
              ? foldersToDelete.length === 1
                ? 'Delete Folder'
                : 'Delete Note'
              : `Delete ${totalItems} Items`}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="text-sm text-muted-foreground">
              <DeleteDialogBody notesToDelete={notesToDelete} foldersToDelete={foldersToDelete} />
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={isDeleting}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isDeleting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Deleting...
              </>
            ) : totalItems === 1 ? (
              'Delete'
            ) : (
              `Delete ${totalItems}`
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
  const totalItems = notesToDelete.length + foldersToDelete.length

  if (totalItems === 1) {
    if (foldersToDelete.length === 1) {
      const folderName = foldersToDelete[0].split('/').pop() || foldersToDelete[0]
      return (
        <>
          Are you sure you want to delete the folder &quot;{folderName}&quot; and all its contents?
          This action cannot be undone.
        </>
      )
    }
    return (
      <>
        Are you sure you want to delete &quot;
        {getDisplayName(notesToDelete[0]?.path || '')}&quot;? This action cannot be undone.
      </>
    )
  }

  return (
    <>
      Are you sure you want to delete these items? This action cannot be undone.
      <ul className="mt-2 max-h-32 overflow-y-auto text-sm list-disc list-inside">
        {foldersToDelete.slice(0, 3).map((folderPath) => (
          <li key={`folder-${folderPath}`} className="flex items-center gap-1">
            <Folder className="h-3 w-3 inline" />
            {folderPath.split('/').pop() || folderPath} (folder)
          </li>
        ))}
        {notesToDelete.slice(0, 5 - Math.min(foldersToDelete.length, 3)).map((note) => (
          <li key={note.id}>{getDisplayName(note.path)}</li>
        ))}
        {totalItems > 5 && <li className="text-muted-foreground">...and {totalItems - 5} more</li>}
      </ul>
    </>
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
