import { Trash2 } from '@/lib/icons'

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
import type { Task } from '@/data/task-model'
import { useT } from '@memry/i18n/renderer'

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
  const { t: tPhaseF } = useT('tasks')
  const handleConfirm = (): void => {
    onConfirm()
  }

  return (
    <AlertDialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-full bg-destructive/10">
              <Trash2 className="size-5 text-destructive" />
            </div>
            <AlertDialogTitle>
              {tPhaseF('phaseF.componentsTasksDialogsDeleteAllSubtasksDialog.deleteAllSubtasks')}
            </AlertDialogTitle>
          </div>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              <p>
                {tPhaseF(
                  'phaseF.componentsTasksDialogsDeleteAllSubtasksDialog.deleteSubtasksConfirmation',
                  { count: subtasks.length, title: parentTitle }
                )}
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

              <p className="text-destructive text-sm font-medium">
                {tPhaseF(
                  'phaseF.componentsTasksDialogsDeleteAllSubtasksDialog.thisActionCannotBeUndone'
                )}
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>
            {tPhaseF('phaseF.componentsTasksDialogsDeleteAllSubtasksDialog.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {tPhaseF('phaseF.componentsTasksDialogsDeleteAllSubtasksDialog.deleteAll')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export default DeleteAllSubtasksDialog
