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

interface WikiLinkCreateDialogProps {
  /** The unresolved wiki-link title, or null when the dialog is closed. */
  targetTitle: string | null
  onClose: () => void
  onConfirm: (title: string) => void
}

/**
 * "No note titled 'X'. Create it?" — the confirm step in front of what used to
 * be a silent auto-create on clicking a broken wiki link (#1716). Both the
 * note editor and the journal open this; create semantics on confirm stay
 * exactly what the auto-create did.
 */
export const WikiLinkCreateDialog = ({
  targetTitle,
  onClose,
  onConfirm
}: WikiLinkCreateDialogProps): React.JSX.Element => {
  const { t } = useT('notes')
  const { t: tCommon } = useT('common')

  return (
    <AlertDialog open={targetTitle !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('wikiLinkCreateDialog.title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('wikiLinkCreateDialog.body', { title: targetTitle ?? '' })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onClose}>{tCommon('button.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              if (targetTitle) onConfirm(targetTitle)
              onClose()
            }}
          >
            {t('wikiLinkCreateDialog.create')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export default WikiLinkCreateDialog
