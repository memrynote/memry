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

interface DeleteCalendarEventDialogProps {
  open: boolean
  title: string
  hasGoogleBinding: boolean
  onCancel: () => void
  onConfirm: () => void
}

export function DeleteCalendarEventDialog({
  open,
  title,
  hasGoogleBinding,
  onCancel,
  onConfirm
}: DeleteCalendarEventDialogProps): React.JSX.Element {
  const { t } = useT('common')
  const description = hasGoogleBinding
    ? `"${title}" will be removed from Memry and Google Calendar. This action cannot be undone.`
    : `"${title}" will be permanently deleted. This action cannot be undone.`

  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete event?</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>{t('button.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export default DeleteCalendarEventDialog
