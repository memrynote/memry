import { useState } from "react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"

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
  onConfirm,
}: BulkDueDatePickerProps): React.JSX.Element => {
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(undefined)
  const [includeTime, setIncludeTime] = useState(false)
  const [selectedTime, setSelectedTime] = useState<string>("12:00")

  const handleConfirm = (): void => {
    if (selectedDate) {
      onConfirm(selectedDate, includeTime ? selectedTime : null)
      onClose()
      // Reset state
      setSelectedDate(undefined)
      setIncludeTime(false)
      setSelectedTime("12:00")
    }
  }

  const handleOpenChange = (isOpen: boolean): void => {
    if (!isOpen) {
      onClose()
      // Reset state when closing
      setSelectedDate(undefined)
      setIncludeTime(false)
      setSelectedTime("12:00")
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            Set due date for {taskCount} task{taskCount !== 1 ? "s" : ""}
          </DialogTitle>
          <DialogDescription>
            Select a date to set as the due date for all selected tasks.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-4 py-4">
          <Calendar
            mode="single"
            selected={selectedDate}
            onSelect={setSelectedDate}
            disabled={(date) => date < new Date(new Date().setHours(0, 0, 0, 0))}
            initialFocus
          />

          <div className="flex w-full items-center justify-between gap-4 px-2">
            <div className="flex items-center gap-2">
              <Switch
                id="include-time"
                checked={includeTime}
                onCheckedChange={setIncludeTime}
              />
              <Label htmlFor="include-time" className="text-sm">
                Also set time
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
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={!selectedDate}>
            Set Due Date
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default BulkDueDatePicker











