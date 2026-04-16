import * as React from 'react'
import { useActionState } from 'react'
import { createLogger } from '@/lib/logger'

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'

const log = createLogger('TagDeleteDialog')

export interface TagDeleteDialogProps {
  tag: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => Promise<void>
}

export function TagDeleteDialog({
  tag,
  open,
  onOpenChange,
  onConfirm
}: TagDeleteDialogProps): React.JSX.Element {
  const [, deleteAction, isPending] = useActionState<null, void>(async () => {
    try {
      await onConfirm()
      onOpenChange(false)
    } catch (err) {
      log.error('Delete tag failed', err)
    }
    return null
  }, null)

  const handleOpenChange = (next: boolean): void => {
    if (!next && isPending) return
    onOpenChange(next)
  }

  const handleConfirm = (): void => {
    React.startTransition(() => deleteAction())
  }

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete tag #{tag}?</AlertDialogTitle>
          <AlertDialogDescription>
            Notes with this tag won&apos;t be deleted, just untagged.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleConfirm} disabled={isPending}>
            {isPending ? 'Deleting...' : 'Delete tag'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export default TagDeleteDialog
