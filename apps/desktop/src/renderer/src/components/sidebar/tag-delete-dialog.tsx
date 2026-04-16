import * as React from 'react'
import { useState } from 'react'

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'

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
  const [submitting, setSubmitting] = useState(false)

  const close = (): void => {
    if (submitting) return
    onOpenChange(false)
  }

  const handleConfirm = async (): Promise<void> => {
    setSubmitting(true)
    try {
      await onConfirm()
      onOpenChange(false)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => (!next ? close() : onOpenChange(next))}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete tag #{tag}?</AlertDialogTitle>
          <AlertDialogDescription>
            Notes with this tag won&apos;t be deleted, just untagged.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" onClick={close} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => void handleConfirm()}
            disabled={submitting}
          >
            {submitting ? 'Deleting...' : 'Delete tag'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export default TagDeleteDialog
