/**
 * The question a note delete asks when the OS trash refuses the note's file (#3813): the file
 * holds text the note never read, so the app moves it to the trash rather than delete it, and
 * where no trash is usable (a Linux drive without a trash folder) the user decides whether it
 * goes for good. `notesService.delete` asks through `askPermanentDelete`, so every
 * caller of a note delete gets the question; the app root renders
 * {@link PermanentDeleteConfirm} once.
 *
 * @module note/permanent-delete-confirm
 */

import { useSyncExternalStore } from 'react'
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
import { answer, current, subscribe } from '@/lib/permanent-delete-question'

export function PermanentDeleteConfirm(): React.JSX.Element {
  const { t } = useT('notes')
  const question = useSyncExternalStore(subscribe, current)
  return (
    <AlertDialog
      open={question !== null}
      onOpenChange={(open) => {
        if (!open) answer(question, false)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('trashUnavailable.title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('trashUnavailable.description', { title: question?.title ?? '' })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => answer(question, false)}>
            {t('trashUnavailable.keep')}
          </AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={() => answer(question, true)}
          >
            {t('trashUnavailable.deletePermanently')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
