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

// ============================================================================
// TYPES
// ============================================================================

interface DeleteTaskDialogProps {
  isOpen: boolean
  onClose: () => void
  onConfirm: () => void
  taskTitle: string
}

// ============================================================================
// DELETE TASK DIALOG COMPONENT
// ============================================================================

export const DeleteTaskDialog = ({
  isOpen,
  onClose,
  onConfirm,
  taskTitle
}: DeleteTaskDialogProps): React.JSX.Element => {
  const { t: tPhaseF } = useT('tasks')
  const { t } = useT('common')

  const handleConfirm = (): void => {
    onConfirm()
    onClose()
  }

  return (
    <AlertDialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {tPhaseF('phaseF.componentsTasksDeleteTaskDialog.deleteTask')}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {tPhaseF('phaseF.componentsTasksDeleteTaskDialog.deleteConfirmBody', {
              title: taskTitle
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onClose}>{t('button.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {tPhaseF('phaseF.componentsTasksDeleteTaskDialog.deleteTask2')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export default DeleteTaskDialog
