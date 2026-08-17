import { AlertTriangle } from '@/lib/icons'

import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import type { Project } from '@/data/tasks-data'
import { useT } from '@memry/i18n/renderer'

// ============================================================================
// TYPES
// ============================================================================

interface DeleteProjectDialogProps {
  isOpen: boolean
  onClose: () => void
  onConfirm: () => void
  project: Project | null
}

// ============================================================================
// DELETE PROJECT DIALOG COMPONENT
// ============================================================================

export const DeleteProjectDialog = ({
  isOpen,
  onClose,
  onConfirm,
  project
}: DeleteProjectDialogProps): React.JSX.Element => {
  const { t: tPhaseF } = useT('tasks')

  const taskCount = project?.taskCount || 0
  const hasTasks = taskCount > 0

  const handleConfirm = (): void => {
    onConfirm()
    onClose()
  }

  if (!project) return <></>

  return (
    <AlertDialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            {tPhaseF('phaseF.componentsTasksDeleteProjectDialog.delete')}
            {project.name}"?
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-4">
              {hasTasks ? (
                <p>
                  {tPhaseF('phaseF.componentsTasksDeleteProjectDialog.thisProjectHas')}
                  {taskCount} {tPhaseF('phaseF.componentsTasksDeleteProjectDialog.task')}
                  {taskCount !== 1 ? 's' : ''}.
                </p>
              ) : (
                <p>
                  {tPhaseF(
                    'phaseF.componentsTasksDeleteProjectDialog.thisProjectHasNoTasksAndWillBePermanentlyDeleted'
                  )}
                </p>
              )}

              <p className="text-sm text-muted-foreground">
                {tPhaseF('phaseF.componentsTasksDeleteProjectDialog.notesEventsAndFilesStayNotice')}
              </p>

              {/* Warning */}
              <div className="flex items-center gap-2 rounded-sm bg-destructive/10 p-3 text-sm text-destructive">
                <AlertTriangle className="size-4 shrink-0" />
                <span>
                  {tPhaseF('phaseF.componentsTasksDeleteProjectDialog.thisActionCannotBeUndone')}
                </span>
              </div>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        <AlertDialogFooter>
          <Button variant="outline" onClick={onClose}>
            {tPhaseF('phaseF.componentsTasksDeleteProjectDialog.cancel')}
          </Button>
          <Button variant="destructive" onClick={handleConfirm}>
            {tPhaseF('phaseF.componentsTasksDeleteProjectDialog.deleteProject')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export default DeleteProjectDialog
