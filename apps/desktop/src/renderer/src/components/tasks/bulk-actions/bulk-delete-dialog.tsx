import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { Task } from '@/data/task-model'
import { useT } from '@memry/i18n/renderer'

// ============================================================================
// TYPES
// ============================================================================

interface BulkDeleteDialogProps {
  /** Whether the dialog is open */
  open: boolean
  /** Callback to close the dialog */
  onClose: () => void
  /** Tasks to be deleted */
  tasks: Task[]
  /** Callback when deletion is confirmed */
  onConfirm: () => void
}

// ============================================================================
// COMPONENT
// ============================================================================

const MAX_VISIBLE_TASKS = 5

/**
 * Confirmation dialog for bulk delete action
 */
export const BulkDeleteDialog = ({
  open,
  onClose,
  tasks,
  onConfirm
}: BulkDeleteDialogProps): React.JSX.Element => {
  const { t: tPhaseF } = useT('tasks')
  const visibleTasks = tasks.slice(0, MAX_VISIBLE_TASKS)
  const remainingCount = tasks.length - MAX_VISIBLE_TASKS

  const handleConfirm = (): void => {
    onConfirm()
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {tPhaseF('phaseF.componentsTasksBulkActionsBulkDeleteDialog.delete')}
            {tasks.length} {tPhaseF('phaseF.componentsTasksBulkActionsBulkDeleteDialog.task')}
            {tasks.length !== 1 ? 's' : ''}?
          </DialogTitle>
          <DialogDescription>
            {tPhaseF('phaseF.componentsTasksBulkActionsBulkDeleteDialog.youReAboutToDelete')}
            {tasks.length} {tPhaseF('phaseF.componentsTasksBulkActionsBulkDeleteDialog.task2')}
            {tasks.length !== 1 ? 's' : ''}:
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 py-4">
          <ul className="min-w-0 space-y-1 text-sm">
            {visibleTasks.map((task) => (
              // `min-w-0` on both the row and the title: a flex item refuses to
              // shrink below its content by default, which is what `truncate`
              // needs it to do.
              <li key={task.id} className="flex min-w-0 items-center gap-2">
                <span className="text-muted-foreground">•</span>
                <span className="min-w-0 truncate" title={task.title}>
                  {task.title}
                </span>
              </li>
            ))}
            {remainingCount > 0 && (
              <li className="text-muted-foreground">
                ... {tPhaseF('phaseF.componentsTasksBulkActionsBulkDeleteDialog.and')}
                {remainingCount}{' '}
                {tPhaseF('phaseF.componentsTasksBulkActionsBulkDeleteDialog.moreTask')}
                {remainingCount !== 1 ? 's' : ''}
              </li>
            )}
          </ul>

          <p className="mt-4 text-sm text-muted-foreground">
            {tPhaseF(
              'phaseF.componentsTasksBulkActionsBulkDeleteDialog.thisActionCanBeUndoneForAShortTimeAfterDeletion'
            )}
          </p>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onClose}>
            {tPhaseF('phaseF.componentsTasksBulkActionsBulkDeleteDialog.cancel')}
          </Button>
          <Button variant="destructive" onClick={handleConfirm}>
            {tPhaseF('phaseF.componentsTasksBulkActionsBulkDeleteDialog.delete2')}
            {tasks.length} {tPhaseF('phaseF.componentsTasksBulkActionsBulkDeleteDialog.task3')}
            {tasks.length !== 1 ? 's' : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default BulkDeleteDialog
