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
  const { t } = useT('common')

  const handleConfirm = (): void => {
    onConfirm()
    onClose()
  }

  return (
    <AlertDialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{/* TODO(i18n): wrap in t() */}Delete task?</AlertDialogTitle>
          <AlertDialogDescription>
            &{/* TODO(i18n): wrap in t() */}ldquo;{taskTitle}&{/* TODO(i18n): wrap in t() */}rdquo;
            will be permanently deleted. This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onClose}>{t('button.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {/* TODO(i18n): wrap in t() */}
            Delete Task
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export default DeleteTaskDialog
