import { Archive } from 'lucide-react'

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

// ============================================================================
// TYPES
// ============================================================================

interface ArchiveConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  taskCount: number
  variant?: 'all' | 'older-than'
  olderThanDays?: number
}

// ============================================================================
// ARCHIVE CONFIRM DIALOG
// ============================================================================

export const ArchiveConfirmDialog = ({
  open,
  onOpenChange,
  onConfirm,
  taskCount,
  variant = 'all',
  olderThanDays = 7
}: ArchiveConfirmDialogProps): React.JSX.Element => {
  const handleConfirm = (): void => {
    onConfirm()
    onOpenChange(false)
  }

  const getTitle = (): string => {
    if (variant === 'older-than') {
      return `Archive tasks older than ${olderThanDays} days?`
    }
    return 'Archive all completed tasks?'
  }

  const getDescription = (): string => {
    if (taskCount === 0) {
      return 'No tasks to archive.'
    }
    const taskText = taskCount === 1 ? 'task' : 'tasks'
    if (variant === 'older-than') {
      return `This will archive ${taskCount} completed ${taskText} that were completed more than ${olderThanDays} days ago. You can restore them from the archive at any time.`
    }
    return `This will archive ${taskCount} completed ${taskText}. You can restore them from the archive at any time.`
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Archive className="size-5" aria-hidden="true" />
            {getTitle()}
          </AlertDialogTitle>
          <AlertDialogDescription>{getDescription()}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleConfirm} disabled={taskCount === 0}>
            Archive {taskCount > 0 ? `${taskCount} task${taskCount !== 1 ? 's' : ''}` : ''}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export default ArchiveConfirmDialog
