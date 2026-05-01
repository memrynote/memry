import { useState, useCallback } from 'react'
import { format } from 'date-fns'

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
import { useT } from '@memry/i18n/renderer'

// ============================================================================
// TYPES
// ============================================================================

export type EditScope = 'this' | 'all'

interface EditRepeatingTaskDialogProps {
  isOpen: boolean
  onClose: () => void
  onConfirm: (scope: EditScope) => void
  taskTitle: string
  occurrenceDate?: Date | null
}

// ============================================================================
// EDIT REPEATING TASK DIALOG COMPONENT
// ============================================================================

export const EditRepeatingTaskDialog = ({
  isOpen,
  onClose,
  onConfirm,
  taskTitle: _taskTitle,
  occurrenceDate
}: EditRepeatingTaskDialogProps): React.JSX.Element => {
  const { t: tPhaseF } = useT('tasks')
  const [selectedScope, setSelectedScope] = useState<EditScope>('all')

  const dateLabel = occurrenceDate ? format(occurrenceDate, 'MMM d') : 'this date'

  const handleConfirm = useCallback((): void => {
    onConfirm(selectedScope)
    onClose()
  }, [selectedScope, onConfirm, onClose])

  return (
    <AlertDialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {tPhaseF('phaseF.componentsTasksEditRepeatingTaskDialog.editRepeatingTask')}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {tPhaseF(
              'phaseF.componentsTasksEditRepeatingTaskDialog.youReEditingARepeatingTaskApplyChangesTo'
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex flex-col gap-3 py-4">
          {/* This occurrence only */}
          <label
            className={cn(
              'flex cursor-pointer items-start gap-3 rounded-sm border p-3 transition-colors',
              selectedScope === 'this'
                ? 'border-primary bg-primary/5'
                : 'border-border hover:bg-accent/50'
            )}
          >
            <input
              type="radio"
              name="editScope"
              checked={selectedScope === 'this'}
              onChange={() => setSelectedScope('this')}
              className="mt-0.5 size-4 accent-primary"
            />
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">
                {tPhaseF('phaseF.componentsTasksEditRepeatingTaskDialog.onlyThisOccurrence')}
              </span>
              <span className="text-xs text-muted-foreground">
                {dateLabel}{' '}
                {tPhaseF('phaseF.componentsTasksEditRepeatingTaskDialog.onlyFutureTasksUnchanged')}
              </span>
            </div>
          </label>

          {/* This and all future */}
          <label
            className={cn(
              'flex cursor-pointer items-start gap-3 rounded-sm border p-3 transition-colors',
              selectedScope === 'all'
                ? 'border-primary bg-primary/5'
                : 'border-border hover:bg-accent/50'
            )}
          >
            <input
              type="radio"
              name="editScope"
              checked={selectedScope === 'all'}
              onChange={() => setSelectedScope('all')}
              className="mt-0.5 size-4 accent-primary"
            />
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">
                {tPhaseF(
                  'phaseF.componentsTasksEditRepeatingTaskDialog.thisAndAllFutureOccurrences'
                )}
              </span>
              <span className="text-xs text-muted-foreground">
                {dateLabel} {tPhaseF('phaseF.componentsTasksEditRepeatingTaskDialog.andBeyond')}
              </span>
            </div>
          </label>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel>
            {tPhaseF('phaseF.componentsTasksEditRepeatingTaskDialog.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction onClick={handleConfirm}>
            {tPhaseF('phaseF.componentsTasksEditRepeatingTaskDialog.continue')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export default EditRepeatingTaskDialog
