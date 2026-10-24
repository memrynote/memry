import { useState } from 'react'
import { Calendar as CalendarIcon } from '@/lib/icons'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { DatePickerCalendar } from '@/components/tasks/date-picker-calendar'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { useT } from '@memry/i18n/renderer'

// ============================================================================
// TYPES
// ============================================================================

interface BulkDueDateDialogProps {
  isOpen: boolean
  parentTitle: string
  subtaskCount: number
  completedCount: number
  onClose: () => void
  onApply: (dueDate: Date | null, includeCompleted: boolean) => void
}

// ============================================================================
// BULK DUE DATE DIALOG COMPONENT
// ============================================================================

export const BulkDueDateDialog = ({
  isOpen,
  parentTitle,
  subtaskCount,
  completedCount,
  onClose,
  onApply
}: BulkDueDateDialogProps): React.JSX.Element => {
  const { t: tPhaseF } = useT('tasks')
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(undefined)
  const [includeCompleted, setIncludeCompleted] = useState(false)

  const handleApply = (): void => {
    onApply(selectedDate || null, includeCompleted)
    setSelectedDate(undefined)
    setIncludeCompleted(false)
    onClose()
  }

  const handleClearDate = (): void => {
    onApply(null, includeCompleted)
    setSelectedDate(undefined)
    setIncludeCompleted(false)
    onClose()
  }

  const handleClose = (): void => {
    setSelectedDate(undefined)
    setIncludeCompleted(false)
    onClose()
  }

  const incompleteCount = subtaskCount - completedCount
  const affectedCount = includeCompleted ? subtaskCount : incompleteCount

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <CalendarIcon className="size-5 text-muted-foreground" />
            <DialogTitle>
              {tPhaseF('phaseF.componentsTasksDialogsBulkDueDateDialog.setDueDateForAllSubtasks')}
            </DialogTitle>
          </div>
          <DialogDescription>
            {tPhaseF('phaseF.componentsTasksDialogsBulkDueDateDialog.setDueDateForSubtasksIn', {
              count: affectedCount,
              title: parentTitle
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          {/* Calendar */}
          <div className="flex justify-center">
            <DatePickerCalendar selected={selectedDate} onSelect={(d) => setSelectedDate(d)} />
          </div>

          {/* Include completed checkbox */}
          {completedCount > 0 && (
            <div className="flex items-center gap-2 mt-4 pt-4 border-t">
              <Checkbox
                id="include-completed"
                checked={includeCompleted}
                onCheckedChange={(checked) => setIncludeCompleted(checked === true)}
              />
              <Label
                htmlFor="include-completed"
                className="text-sm text-muted-foreground cursor-pointer"
              >
                {tPhaseF(
                  'phaseF.componentsTasksDialogsBulkDueDateDialog.alsoApplyToCompletedSubtasksCount',
                  { count: completedCount }
                )}
              </Label>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="ghost" onClick={handleClearDate}>
            {tPhaseF('phaseF.componentsTasksDialogsBulkDueDateDialog.clearDate')}
          </Button>
          <Button variant="outline" onClick={handleClose}>
            {tPhaseF('phaseF.componentsTasksDialogsBulkDueDateDialog.cancel')}
          </Button>
          <Button onClick={handleApply} disabled={!selectedDate}>
            {tPhaseF('phaseF.componentsTasksDialogsBulkDueDateDialog.apply')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default BulkDueDateDialog
