import { useState } from "react"
import { Copy } from "lucide-react"

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

// ============================================================================
// TYPES
// ============================================================================

interface DuplicateWithSubtasksDialogProps {
  isOpen: boolean
  taskTitle: string
  subtaskCount: number
  onClose: () => void
  onDuplicate: (includeSubtasks: boolean) => void
}

// ============================================================================
// DUPLICATE WITH SUBTASKS DIALOG COMPONENT
// ============================================================================

export const DuplicateWithSubtasksDialog = ({
  isOpen,
  taskTitle,
  subtaskCount,
  onClose,
  onDuplicate,
}: DuplicateWithSubtasksDialogProps): React.JSX.Element => {
  const [includeSubtasks, setIncludeSubtasks] = useState(true)

  const handleDuplicate = (): void => {
    onDuplicate(includeSubtasks)
    setIncludeSubtasks(true)
    onClose()
  }

  const handleClose = (): void => {
    setIncludeSubtasks(true)
    onClose()
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Copy className="size-5 text-muted-foreground" />
            <DialogTitle>Duplicate task</DialogTitle>
          </div>
          <DialogDescription>
            Create a copy of &ldquo;{taskTitle}&rdquo;
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          <div className="flex items-start gap-3 p-4 rounded-lg border bg-muted/30">
            <Checkbox
              id="include-subtasks"
              checked={includeSubtasks}
              onCheckedChange={(checked) => setIncludeSubtasks(checked === true)}
            />
            <div className="space-y-1">
              <Label
                htmlFor="include-subtasks"
                className="cursor-pointer font-medium"
              >
                Also duplicate subtasks ({subtaskCount})
              </Label>
              <p className="text-sm text-muted-foreground">
                {includeSubtasks
                  ? "Subtasks will be copied with completion status reset"
                  : "Only the parent task will be duplicated"}
              </p>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            Cancel
          </Button>
          <Button onClick={handleDuplicate}>
            Duplicate {includeSubtasks ? `(${subtaskCount + 1} items)` : "task"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default DuplicateWithSubtasksDialog








