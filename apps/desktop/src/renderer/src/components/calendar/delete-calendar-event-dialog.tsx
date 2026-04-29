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
  const { t } = useT('calendar')
  const { t: tCommon } = useT('common')
  const description = hasGoogleBinding
    ? t('delete-dialog.google-bound-description', { title })
    : t('delete-dialog.local-description', { title })

  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('delete-dialog.title')}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>{tCommon('button.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {tCommon('button.delete')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export default DeleteCalendarEventDialog
