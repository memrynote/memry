import { Trash2 } from 'lucide-react'

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
import { ScrollArea } from '@/components/ui/scroll-area'
import type { Task } from '@/data/sample-tasks'

// ============================================================================
// TYPES
// ============================================================================

interface DeleteAllSubtasksDialogProps {
  isOpen: boolean
  parentTitle: string
  subtasks: Task[]
  onClose: () => void
  onConfirm: () => void
}

// ============================================================================
// DELETE ALL SUBTASKS DIALOG COMPONENT
// ============================================================================

export const DeleteAllSubtasksDialog = ({
  isOpen,
  parentTitle,
  subtasks,
  onClose,
  onConfirm
}: DeleteAllSubtasksDialogProps): React.JSX.Element => {
  const handleConfirm = (): void => {
    onConfirm()
    onClose()
  }

  return (
    <AlertDialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-full bg-destructive/10">
              <Trash2 className="size-5 text-destructive" />
            </div>
            <AlertDialogTitle>Delete all subtasks?</AlertDialogTitle>
          </div>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              <p>
                This will delete {subtasks.length} subtask
                {subtasks.length !== 1 ? 's' : ''} from &ldquo;{parentTitle}
                &rdquo;.
              </p>

              {/* Subtask list */}
              <ScrollArea className="max-h-[200px] rounded-sm border p-3">
                <ul className="space-y-1.5">
                  {subtasks.map((subtask) => (
                    <li key={subtask.id} className="flex items-center gap-2 text-sm">
                      <span className="text-muted-foreground">•</span>
                      <span className="truncate">{subtask.title}</span>
                      {subtask.completedAt && <span className="text-xs text-task-complete">✓</span>}
                    </li>
                  ))}
                </ul>
              </ScrollArea>

              <p className="text-destructive text-sm font-medium">This action cannot be undone.</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            Delete All
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export default DeleteAllSubtasksDialog
