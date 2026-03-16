import { useState } from 'react'
import { AlertTriangle, Trash2 } from 'lucide-react'

import { cn } from '@/lib/utils'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

// ============================================================================
// TYPES
// ============================================================================

interface DeleteCompletedDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  taskCount: number
  variant?: 'completed' | 'archived'
}

// ============================================================================
// DELETE COMPLETED DIALOG
// ============================================================================

export const DeleteCompletedDialog = ({
  open,
  onOpenChange,
  onConfirm,
  taskCount,
  variant = 'completed'
}: DeleteCompletedDialogProps): React.JSX.Element => {
  const [confirmText, setConfirmText] = useState('')

  const isConfirmValid = confirmText.toLowerCase() === 'delete'

  const handleConfirm = (): void => {
    if (isConfirmValid) {
      onConfirm()
      onOpenChange(false)
      setConfirmText('')
    }
  }

  const handleOpenChange = (newOpen: boolean): void => {
    if (!newOpen) {
      setConfirmText('')
    }
    onOpenChange(newOpen)
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && isConfirmValid) {
      e.preventDefault()
      handleConfirm()
    }
  }

  const getTitle = (): string => {
    if (variant === 'archived') {
      return 'Delete all archived tasks permanently?'
    }
    return 'Delete all completed tasks permanently?'
  }

  const getDescription = (): string => {
    const taskText = taskCount === 1 ? 'task' : 'tasks'
    if (variant === 'archived') {
      return `This will permanently delete ${taskCount} archived ${taskText}. This action cannot be undone.`
    }
    return `This will permanently delete ${taskCount} completed ${taskText}. This action cannot be undone.`
  }

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="size-5" aria-hidden="true" />
            {getTitle()}
          </AlertDialogTitle>
          <AlertDialogDescription>{getDescription()}</AlertDialogDescription>
        </AlertDialogHeader>

        <div className="my-4 space-y-3">
          <div className="rounded-sm border border-destructive/30 bg-destructive/5 p-3">
            <div className="flex items-start gap-2">
              <Trash2 className="size-4 text-destructive mt-0.5 shrink-0" aria-hidden="true" />
              <p className="text-sm text-destructive">
                This is a destructive action. All {taskCount}{' '}
                {variant === 'archived' ? 'archived' : 'completed'} task{taskCount !== 1 ? 's' : ''}{' '}
                will be permanently deleted and cannot be recovered.
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirm-delete" className="text-sm text-text-secondary">
              Type <span className="font-mono font-semibold">delete</span> to confirm
            </Label>
            <Input
              id="confirm-delete"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="delete"
              className={cn(
                'font-mono',
                isConfirmValid && 'border-destructive focus-visible:ring-destructive'
              )}
              autoComplete="off"
              autoFocus
            />
          </div>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={!isConfirmValid || taskCount === 0}
          >
            <Trash2 className="size-4 mr-2" aria-hidden="true" />
            Delete {taskCount} task{taskCount !== 1 ? 's' : ''} permanently
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export default DeleteCompletedDialog
