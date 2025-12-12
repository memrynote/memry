import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import type { Task } from "@/data/sample-tasks"

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
  onConfirm,
}: BulkDeleteDialogProps): React.JSX.Element => {
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
            Delete {tasks.length} task{tasks.length !== 1 ? "s" : ""}?
          </DialogTitle>
          <DialogDescription>
            You&apos;re about to delete {tasks.length} task{tasks.length !== 1 ? "s" : ""}:
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          <ul className="space-y-1 text-sm">
            {visibleTasks.map((task) => (
              <li key={task.id} className="flex items-center gap-2">
                <span className="text-muted-foreground">•</span>
                <span className="truncate">{task.title}</span>
              </li>
            ))}
            {remainingCount > 0 && (
              <li className="text-muted-foreground">
                ... and {remainingCount} more task{remainingCount !== 1 ? "s" : ""}
              </li>
            )}
          </ul>

          <p className="mt-4 text-sm text-muted-foreground">
            This action can be undone for a short time after deletion.
          </p>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleConfirm}>
            Delete {tasks.length} task{tasks.length !== 1 ? "s" : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default BulkDeleteDialog











