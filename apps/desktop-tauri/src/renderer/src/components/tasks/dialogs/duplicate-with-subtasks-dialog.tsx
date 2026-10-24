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
import { useT } from '@memry/i18n/renderer'

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
  const { t: tPhaseF } = useT('tasks')
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
            <DialogTitle>
              {tPhaseF('phaseF.componentsTasksDialogsDuplicateWithSubtasksDialog.duplicateTask')}
            </DialogTitle>
          </div>
          <DialogDescription>
            {tPhaseF(
              'phaseF.componentsTasksDialogsDuplicateWithSubtasksDialog.createACopyOfTitle',
              { title: taskTitle }
            )}
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
                {tPhaseF(
                  'phaseF.componentsTasksDialogsDuplicateWithSubtasksDialog.alsoDuplicateSubtasksCount',
                  { count: subtaskCount }
                )}
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
            {tPhaseF('phaseF.componentsTasksDialogsDuplicateWithSubtasksDialog.cancel')}
          </Button>
          <Button onClick={handleDuplicate}>
            {includeSubtasks
              ? tPhaseF(
                  'phaseF.componentsTasksDialogsDuplicateWithSubtasksDialog.duplicateWithItems',
                  { count: subtaskCount + 1 }
                )
              : tPhaseF(
                  'phaseF.componentsTasksDialogsDuplicateWithSubtasksDialog.duplicateTaskOnly'
                )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default DuplicateWithSubtasksDialog
