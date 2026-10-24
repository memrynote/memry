import { useRef } from 'react'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import type { Task } from '@/data/task-model'
import { useT } from '@memry/i18n/renderer'

export interface DeleteParentBranch {
  /** Direct subtasks. */
  direct: number
  /** Tasks below the direct subtasks. */
  deeper: number
  /** Open tasks anywhere in the branch. */
  open: number
}

interface DeleteParentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  parent: Task | null
  branch: DeleteParentBranch
  onConfirm: (keepSubtasks: boolean) => void
}

/**
 * Deleting a task that has subtasks asks once, naming how much is under it.
 * "Keep subtasks" moves the direct subtasks up into the deleted task's place;
 * it is the focused choice unless everything under the task is already done.
 * Both choices can be undone.
 */
export const DeleteParentDialog = ({
  open,
  onOpenChange,
  parent,
  branch,
  onConfirm
}: DeleteParentDialogProps): React.JSX.Element | null => {
  const { t } = useT('tasks')
  const deleteAllRef = useRef<HTMLButtonElement>(null)
  const keepRef = useRef<HTMLButtonElement>(null)
  if (!parent) return null

  const keepIsDefault = branch.open > 0
  const confirm = (keepSubtasks: boolean): void => {
    onConfirm(keepSubtasks)
    onOpenChange(false)
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        className="sm:max-w-md"
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          ;(keepIsDefault ? keepRef : deleteAllRef).current?.focus()
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('subtaskTree.deleteParent.title', { title: parent.title })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t('subtaskTree.deleteParent.summary', {
              direct: branch.direct,
              deeper: branch.deeper,
              open: branch.open
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="sm:justify-between">
          <AlertDialogCancel>{t('subtaskTree.deleteParent.cancel')}</AlertDialogCancel>
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="text-destructive hover:text-destructive"
              onClick={() => confirm(false)}
              ref={deleteAllRef}
            >
              {t('subtaskTree.deleteParent.deleteAll')}
            </Button>
            <Button onClick={() => confirm(true)} ref={keepRef}>
              {t('subtaskTree.deleteParent.keepSubtasks')}
            </Button>
          </div>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export default DeleteParentDialog
