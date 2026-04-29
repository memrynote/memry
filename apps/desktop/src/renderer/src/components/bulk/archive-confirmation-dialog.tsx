import { useEffect, useCallback } from 'react'
import { Archive } from '@/lib/icons'
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

interface ArchiveConfirmationDialogProps {
  isOpen: boolean
  itemCount: number
  onConfirm: () => void
  onCancel: () => void
}

const ArchiveConfirmationDialog = ({
  isOpen,
  itemCount,
  onConfirm,
  onCancel
}: ArchiveConfirmationDialogProps): React.JSX.Element => {
  const { t } = useT('inbox')
  const { t: tCommon } = useT('common')

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (!isOpen) return

      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onCancel])

  const handleOpenChange = useCallback(
    (open: boolean): void => {
      if (!open) {
        onCancel()
      }
    },
    [onCancel]
  )

  return (
    <AlertDialog open={isOpen} onOpenChange={handleOpenChange}>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Archive className="size-5 text-muted-foreground" aria-hidden="true" />
            {t('bulk.archiveDialog.title', { count: itemCount })}
          </AlertDialogTitle>
          <AlertDialogDescription>{t('bulk.archiveDialog.description')}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>{tCommon('button.cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            {t('bulk.archiveDialog.confirm', { count: itemCount })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export { ArchiveConfirmationDialog }
