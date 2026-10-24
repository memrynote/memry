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
import { Check } from '@/lib/icons'

interface ReadwiseReimportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  onConfirm: () => void
}

/** The confirm before Re-import from Readwise (#1408 D16): text inside the section is lost. */
export function ReadwiseReimportDialog({
  open,
  onOpenChange,
  title,
  onConfirm
}: ReadwiseReimportDialogProps): React.JSX.Element {
  const { t } = useT('notes')
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('readwise.reimport.title', { title })}</AlertDialogTitle>
          <AlertDialogDescription>{t('readwise.reimport.body')}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex items-start gap-2 rounded-md bg-surface px-3 py-2.5 text-xs/4 text-foreground">
          <Check className="mt-0.5 size-3.5 shrink-0 text-green-700 dark:text-green-500" />
          <span>{t('readwise.reimport.note')}</span>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('readwise.reimport.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            className="border border-destructive bg-transparent text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => {
              onOpenChange(false)
              onConfirm()
            }}
          >
            {t('readwise.reimport.confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
