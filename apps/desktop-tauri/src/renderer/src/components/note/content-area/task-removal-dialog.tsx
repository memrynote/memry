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
import { useT } from '@memry/i18n/renderer'

interface TaskRemovalDialogProps {
  /** Tasks whose blocks just left the note. The dialog is closed while this is 0. */
  count: number
  /**
   * Every close runs this, the delete button's included (it closes the dialog
   * after `onDelete`), so it must be a no-op once `onDelete` took the tasks.
   */
  onKeep: () => void
  onDelete: () => void
}

/**
 * Asked after task blocks are deleted from a note: the blocks are already gone,
 * and the question is only what happens to the tasks. Keeping is the default
 * answer — the focused button, Escape, and a click outside all mean keep — so
 * the one irreversible choice always takes a deliberate click.
 */
export function TaskRemovalDialog({
  count,
  onKeep,
  onDelete
}: TaskRemovalDialogProps): React.JSX.Element {
  const { t } = useT('notes')

  return (
    <AlertDialog open={count > 0} onOpenChange={(open) => !open && onKeep()}>
      <AlertDialogContent data-testid="task-removal-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('editor.taskRemoval.title', { count })}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('editor.taskRemoval.description', { count })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('editor.taskRemoval.keep')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={onDelete}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {t('editor.taskRemoval.delete', { count })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
