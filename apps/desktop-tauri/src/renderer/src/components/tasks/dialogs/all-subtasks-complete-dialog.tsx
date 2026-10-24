import { CheckCircle2 } from '@/lib/icons'

import { useT } from '@memry/i18n/renderer'
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

// ============================================================================
// TYPES
// ============================================================================

interface AllSubtasksCompleteDialogProps {
  isOpen: boolean
  parentTitle: string
  subtaskCount: number
  onClose: () => void
  onKeepOpen: () => void
  onCompleteParent: () => void
}

// ============================================================================
// ALL SUBTASKS COMPLETE DIALOG COMPONENT
// ============================================================================

export const AllSubtasksCompleteDialog = ({
  isOpen,
  parentTitle,
  subtaskCount,
  onClose,
  onKeepOpen,
  onCompleteParent
}: AllSubtasksCompleteDialogProps): React.JSX.Element => {
  const { t: tPhaseF } = useT('tasks')
  const handleKeepOpen = (): void => {
    onKeepOpen()
  }

  const handleComplete = (): void => {
    onCompleteParent()
  }

  return (
    <AlertDialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-full bg-task-complete/15">
              <CheckCircle2 className="size-5 text-task-complete" />
            </div>
            <AlertDialogTitle>
              {tPhaseF(
                'phaseF.componentsTasksDialogsAllSubtasksCompleteDialog.allSubtasksComplete'
              )}
            </AlertDialogTitle>
          </div>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                {tPhaseF(
                  'phaseF.componentsTasksDialogsAllSubtasksCompleteDialog.allSubtasksDoneBody',
                  { title: parentTitle, count: subtaskCount }
                )}
              </p>
              <p className="text-muted-foreground">
                {tPhaseF(
                  'phaseF.componentsTasksDialogsAllSubtasksCompleteDialog.wouldYouLikeToMarkTheParentTaskAsCompleteToo'
                )}
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={handleKeepOpen}>
            {tPhaseF('phaseF.componentsTasksDialogsAllSubtasksCompleteDialog.keepTaskOpen')}
          </AlertDialogCancel>
          <AlertDialogAction onClick={handleComplete}>
            {tPhaseF('phaseF.componentsTasksDialogsAllSubtasksCompleteDialog.completeTask')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export default AllSubtasksCompleteDialog
