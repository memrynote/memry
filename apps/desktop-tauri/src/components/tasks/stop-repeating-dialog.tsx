import { useState, useCallback } from 'react'
import { RefreshCw } from '@/lib/icons'

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction
} from '@/components/ui/alert-dialog'
import { cn } from '@/lib/utils'
import { getRepeatDisplayText } from '@/lib/repeat-utils'
import type { RepeatConfig } from '@/data/sample-tasks'

// ============================================================================
// TYPES
// ============================================================================

export type StopRepeatOption = 'keep' | 'delete'

interface StopRepeatingDialogProps {
  isOpen: boolean
  onClose: () => void
  onConfirm: (option: StopRepeatOption) => void
  taskTitle: string
  repeatConfig: RepeatConfig | null
}

// ============================================================================
// STOP REPEATING DIALOG COMPONENT
// ============================================================================

export const StopRepeatingDialog = ({
  isOpen,
  onClose,
  onConfirm,
  taskTitle,
  repeatConfig
}: StopRepeatingDialogProps): React.JSX.Element => {
  const [selectedOption, setSelectedOption] = useState<StopRepeatOption>('keep')

  const repeatText = repeatConfig
    ? getRepeatDisplayText(repeatConfig).toLowerCase()
    : 'on a schedule'

  const handleConfirm = useCallback((): void => {
    onConfirm(selectedOption)
    onClose()
  }, [selectedOption, onConfirm, onClose])

  return (
    <AlertDialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <RefreshCw className="size-5 text-muted-foreground" />
            Stop Repeating
          </AlertDialogTitle>
          <AlertDialogDescription>
            "{taskTitle}" is set to repeat {repeatText}. What would you like to do?
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex flex-col gap-3 py-4">
          {/* Keep this task option */}
          <label
            className={cn(
              'flex cursor-pointer items-start gap-3 rounded-sm border p-3 transition-colors',
              selectedOption === 'keep'
                ? 'border-primary bg-primary/5'
                : 'border-border hover:bg-accent/50'
            )}
          >
            <input
              type="radio"
              name="stopOption"
              checked={selectedOption === 'keep'}
              onChange={() => setSelectedOption('keep')}
              className="mt-0.5 size-4 accent-primary"
            />
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">Keep this task, stop future occurrences</span>
              <span className="text-xs text-muted-foreground">
                Task will become a one-time task
              </span>
            </div>
          </label>

          {/* Delete all option */}
          <label
            className={cn(
              'flex cursor-pointer items-start gap-3 rounded-sm border p-3 transition-colors',
              selectedOption === 'delete'
                ? 'border-destructive bg-destructive/5'
                : 'border-border hover:bg-accent/50'
            )}
          >
            <input
              type="radio"
              name="stopOption"
              checked={selectedOption === 'delete'}
              onChange={() => setSelectedOption('delete')}
              className="mt-0.5 size-4 accent-destructive"
            />
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium text-destructive">
                Delete this and all future occurrences
              </span>
              <span className="text-xs text-muted-foreground">Task will be removed entirely</span>
            </div>
          </label>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            className={cn(
              selectedOption === 'delete' &&
                'bg-destructive text-destructive-foreground hover:bg-destructive/90'
            )}
          >
            Confirm
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export default StopRepeatingDialog
