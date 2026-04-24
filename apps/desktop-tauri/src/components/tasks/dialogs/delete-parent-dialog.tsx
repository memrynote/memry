import { useState } from 'react'
import { AlertTriangle } from '@/lib/icons'

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
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'
import type { Task } from '@/data/sample-tasks'

// ============================================================================
// TYPES
// ============================================================================

interface DeleteParentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  parent: Task | null
  subtaskCount: number
  onConfirm: (keepSubtasks: boolean) => void
}

type DeleteOption = 'delete-all' | 'keep-subtasks'

// ============================================================================
// DELETE PARENT DIALOG COMPONENT
// ============================================================================

export const DeleteParentDialog = ({
  open,
  onOpenChange,
  parent,
  subtaskCount,
  onConfirm
}: DeleteParentDialogProps): React.JSX.Element | null => {
  const [option, setOption] = useState<DeleteOption>('delete-all')

  if (!parent) return null

  const handleConfirm = (): void => {
    onConfirm(option === 'keep-subtasks')
    onOpenChange(false)
    // Reset option for next time
    setOption('delete-all')
  }

  const handleCancel = (): void => {
    onOpenChange(false)
    setOption('delete-all')
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            Delete task with subtasks?
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              <p>
                <span className="font-medium text-foreground">"{parent.title}"</span> has{' '}
                {subtaskCount} subtask{subtaskCount !== 1 ? 's' : ''}.
              </p>
              <p>What would you like to do?</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="py-4">
          <RadioGroup
            value={option}
            onValueChange={(value) => setOption(value as DeleteOption)}
            className="space-y-3"
          >
            <div className="flex items-start space-x-3 rounded-sm border p-4 cursor-pointer hover:bg-accent/50 transition-colors">
              <RadioGroupItem value="delete-all" id="delete-all" className="mt-0.5" />
              <Label htmlFor="delete-all" className="cursor-pointer flex-1">
                <div className="font-medium">Delete task and all subtasks</div>
                <div className="text-sm text-muted-foreground mt-1">
                  Permanently removes everything
                </div>
              </Label>
            </div>

            <div className="flex items-start space-x-3 rounded-sm border p-4 cursor-pointer hover:bg-accent/50 transition-colors">
              <RadioGroupItem value="keep-subtasks" id="keep-subtasks" className="mt-0.5" />
              <Label htmlFor="keep-subtasks" className="cursor-pointer flex-1">
                <div className="font-medium">Delete task, keep subtasks as standalone tasks</div>
                <div className="text-sm text-muted-foreground mt-1">
                  Subtasks become top-level tasks
                </div>
              </Label>
            </div>
          </RadioGroup>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel onClick={handleCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export default DeleteParentDialog
