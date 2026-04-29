import { CheckCircle2 } from '@/lib/icons'

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

interface AllSubtasksCompleteDialogProps {
  isOpen: boolean
  parentTitle: string
  subtaskCount: number
  onClose: () => void
  onKeepOpen: () => void
  onCompleteParent: () => void
}

// ============================================================================
// ALL SUBTASKS COMPLETE DIALOG COMPONENT
// ============================================================================

export const AllSubtasksCompleteDialog = ({
  isOpen,
  parentTitle,
  subtaskCount,
  onClose,
  onKeepOpen,
  onCompleteParent
}: AllSubtasksCompleteDialogProps): React.JSX.Element => {
  const handleKeepOpen = (): void => {
    onKeepOpen()
    onClose()
  }

  const handleComplete = (): void => {
    onCompleteParent()
    onClose()
  }

  return (
    <AlertDialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-full bg-task-complete/15">
              <CheckCircle2 className="size-5 text-task-complete" />
            </div>
            <AlertDialogTitle>
              {/* TODO(i18n): wrap in t() */}All subtasks complete!
            </AlertDialogTitle>
          </div>
          <AlertDialogDescription className="space-y-2">
            <p>
              &{/* TODO(i18n): wrap in t() */}ldquo;{parentTitle}&{/* TODO(i18n): wrap in t() */}
              rdquo; has all {subtaskCount} {/* TODO(i18n): wrap in t() */}subtask
              {subtaskCount !== 1 ? 's' : ''} {/* TODO(i18n): wrap in t() */}done.
            </p>
            <p className="text-muted-foreground">
              {/* TODO(i18n): wrap in t() */}
              Would you like to mark the parent task as complete too?
            </p>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={handleKeepOpen}>
            {/* TODO(i18n): wrap in t() */}Keep task open
          </AlertDialogCancel>
          <AlertDialogAction onClick={handleComplete}>
            {/* TODO(i18n): wrap in t() */}Complete task ✓
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export default AllSubtasksCompleteDialog
