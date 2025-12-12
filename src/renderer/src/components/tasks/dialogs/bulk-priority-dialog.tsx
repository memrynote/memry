import { useState } from "react"
import { Flag } from "lucide-react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { cn } from "@/lib/utils"
import { priorityConfig, type Priority } from "@/data/sample-tasks"

// ============================================================================
// TYPES
// ============================================================================

interface BulkPriorityDialogProps {
  isOpen: boolean
  parentTitle: string
  subtaskCount: number
  completedCount: number
  onClose: () => void
  onApply: (priority: Priority, includeCompleted: boolean) => void
}

// ============================================================================
// PRIORITY OPTIONS
// ============================================================================

const priorityOptions: { value: Priority; label: string; color: string | null }[] = [
  { value: "none", label: "No priority", color: null },
  { value: "low", label: "Low", color: priorityConfig.low.color },
  { value: "medium", label: "Medium", color: priorityConfig.medium.color },
  { value: "high", label: "High", color: priorityConfig.high.color },
  { value: "urgent", label: "Urgent", color: priorityConfig.urgent.color },
]

// ============================================================================
// BULK PRIORITY DIALOG COMPONENT
// ============================================================================

export const BulkPriorityDialog = ({
  isOpen,
  parentTitle,
  subtaskCount,
  completedCount,
  onClose,
  onApply,
}: BulkPriorityDialogProps): React.JSX.Element => {
  const [selectedPriority, setSelectedPriority] = useState<Priority>("none")
  const [includeCompleted, setIncludeCompleted] = useState(false)

  const handleApply = (): void => {
    onApply(selectedPriority, includeCompleted)
    setSelectedPriority("none")
    setIncludeCompleted(false)
    onClose()
  }

  const handleClose = (): void => {
    setSelectedPriority("none")
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
            <Flag className="size-5 text-muted-foreground" />
            <DialogTitle>Set priority for all subtasks</DialogTitle>
          </div>
          <DialogDescription>
            Set priority for {affectedCount} subtask{affectedCount !== 1 ? "s" : ""} in
            &ldquo;{parentTitle}&rdquo;
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          {/* Priority options */}
          <RadioGroup
            value={selectedPriority}
            onValueChange={(value) => setSelectedPriority(value as Priority)}
            className="space-y-2"
          >
            {priorityOptions.map((option) => (
              <div
                key={option.value}
                className={cn(
                  "flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors",
                  selectedPriority === option.value
                    ? "border-primary bg-primary/5"
                    : "border-border hover:bg-accent/50"
                )}
                onClick={() => setSelectedPriority(option.value)}
              >
                <RadioGroupItem value={option.value} id={option.value} />
                {option.color ? (
                  <span
                    className="size-3 rounded-full"
                    style={{ backgroundColor: option.color }}
                  />
                ) : (
                  <span className="size-3 rounded-full border-2 border-muted-foreground/40" />
                )}
                <Label htmlFor={option.value} className="cursor-pointer flex-1">
                  {option.label}
                </Label>
              </div>
            ))}
          </RadioGroup>

          {/* Include completed checkbox */}
          {completedCount > 0 && (
            <div className="flex items-center gap-2 mt-4 pt-4 border-t">
              <Checkbox
                id="include-completed-priority"
                checked={includeCompleted}
                onCheckedChange={(checked) =>
                  setIncludeCompleted(checked === true)
                }
              />
              <Label
                htmlFor="include-completed-priority"
                className="text-sm text-muted-foreground cursor-pointer"
              >
                Also apply to completed subtasks ({completedCount})
              </Label>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            Cancel
          </Button>
          <Button onClick={handleApply}>Apply</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default BulkPriorityDialog








