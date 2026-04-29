import { useState } from 'react'
import { Copy } from '@/lib/icons'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'

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
  onDuplicate
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
            <DialogTitle>{/* TODO(i18n): wrap in t() */}Duplicate task</DialogTitle>
          </div>
          <DialogDescription>
            {/* TODO(i18n): wrap in t() */}Create a copy of &ldquo;{taskTitle}&
            {/* TODO(i18n): wrap in t() */}rdquo;
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          <div className="flex items-start gap-3 p-4 rounded-sm border bg-muted/30">
            <Checkbox
              id="include-subtasks"
              checked={includeSubtasks}
              onCheckedChange={(checked) => setIncludeSubtasks(checked === true)}
            />
            <div className="space-y-1">
              <Label htmlFor="include-subtasks" className="cursor-pointer font-medium">
                {/* TODO(i18n): wrap in t() */}
                Also duplicate subtasks ({subtaskCount})
              </Label>
              <p className="text-sm text-muted-foreground">
                {includeSubtasks
                  ? 'Subtasks will be copied with completion status reset'
                  : 'Only the parent task will be duplicated'}
              </p>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            {/* TODO(i18n): wrap in t() */}
            Cancel
          </Button>
          <Button onClick={handleDuplicate}>
            {/* TODO(i18n): wrap in t() */}
            Duplicate {includeSubtasks ? `(${subtaskCount + 1} items)` : 'task'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default DuplicateWithSubtasksDialog
