import { useEffect, useCallback } from 'react'
import { AlertTriangle } from '@/lib/icons'
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

interface DeleteConfirmationDialogProps {
  isOpen: boolean
  itemCount: number
  onConfirm: () => void
  onCancel: () => void
}

const DeleteConfirmationDialog = ({
  isOpen,
  itemCount,
  onConfirm,
  onCancel
}: DeleteConfirmationDialogProps): React.JSX.Element => {
  const { t } = useT('common')

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
            <AlertTriangle className="size-5 text-red-500" aria-hidden="true" />
            {/* TODO(i18n): wrap in t() */}
            Delete {itemCount} {/* TODO(i18n): wrap in t() */}item{itemCount !== 1 ? 's' : ''}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {/* TODO(i18n): wrap in t() */}
            These items will be removed from your inbox. You can undo this action immediately after.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>{t('button.cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} className="bg-red-500 text-white hover:bg-red-600">
            {t('count.itemDelete', { count: itemCount })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export { DeleteConfirmationDialog }
