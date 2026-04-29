import { useState } from 'react'

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
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { useT } from '@memry/i18n/renderer'

// ============================================================================
// TYPES
// ============================================================================

interface BulkDueDatePickerProps {
  /** Whether the dialog is open */
  open: boolean
  /** Callback to close the dialog */
  onClose: () => void
  /** Number of tasks being updated */
  taskCount: number
  /** Callback when date is confirmed */
  onConfirm: (date: Date, time: string | null) => void
}

// ============================================================================
// COMPONENT
// ============================================================================

/**
 * Dialog with calendar picker for setting due date on multiple tasks
 */
export const BulkDueDatePicker = ({
  open,
  onClose,
  taskCount,
  onConfirm
}: BulkDueDatePickerProps): React.JSX.Element => {
  const { t: tPhaseF } = useT('tasks')
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(undefined)
  const [includeTime, setIncludeTime] = useState(false)
  const [selectedTime, setSelectedTime] = useState<string>('12:00')

  const handleConfirm = (): void => {
    if (selectedDate) {
      onConfirm(selectedDate, includeTime ? selectedTime : null)
      onClose()
      // Reset state
      setSelectedDate(undefined)
      setIncludeTime(false)
      setSelectedTime('12:00')
    }
  }

  const handleOpenChange = (isOpen: boolean): void => {
    if (!isOpen) {
      onClose()
      // Reset state when closing
      setSelectedDate(undefined)
      setIncludeTime(false)
      setSelectedTime('12:00')
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {tPhaseF('phaseF.componentsTasksBulkActionsBulkDueDatePicker.setDueDateFor')}
            {taskCount} {tPhaseF('phaseF.componentsTasksBulkActionsBulkDueDatePicker.task')}
            {taskCount !== 1 ? 's' : ''}
          </DialogTitle>
          <DialogDescription>
            {tPhaseF(
              'phaseF.componentsTasksBulkActionsBulkDueDatePicker.selectADateToSetAsTheDueDateForAllSelectedTasks'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-4 py-4">
          <DatePickerCalendar
            selected={selectedDate}
            onSelect={(d) => setSelectedDate(d)}
            disabled={(date) => date < new Date(new Date().setHours(0, 0, 0, 0))}
          />

          <div className="flex w-full items-center justify-between gap-4 px-2">
            <div className="flex items-center gap-2">
              <Switch id="include-time" checked={includeTime} onCheckedChange={setIncludeTime} />
              <Label htmlFor="include-time" className="text-sm">
                {tPhaseF('phaseF.componentsTasksBulkActionsBulkDueDatePicker.alsoSetTime')}
              </Label>
            </div>

            {includeTime && (
              <Input
                type="time"
                value={selectedTime}
                onChange={(e) => setSelectedTime(e.target.value)}
                className="w-32"
              />
            )}
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onClose}>
            {tPhaseF('phaseF.componentsTasksBulkActionsBulkDueDatePicker.cancel')}
          </Button>
          <Button onClick={handleConfirm} disabled={!selectedDate}>
            {tPhaseF('phaseF.componentsTasksBulkActionsBulkDueDatePicker.setDueDate')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default BulkDueDatePicker
