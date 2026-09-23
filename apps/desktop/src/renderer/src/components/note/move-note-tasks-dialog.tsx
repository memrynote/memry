import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useT } from '@memry/i18n/renderer'

interface MoveNoteTasksDialogProps {
  isOpen: boolean
  taskCount: number
  projectName: string
  isMoving: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Confirmation shown when a note is given a project and the tasks already
 * written in it belong somewhere else (#2271). Declining is a real answer, so
 * the dismiss path and the cancel button both mean "leave them".
 */
export function MoveNoteTasksDialog({
  isOpen,
  taskCount,
  projectName,
  isMoving,
  onConfirm,
  onCancel
}: MoveNoteTasksDialogProps): React.JSX.Element {
  const { t } = useT('notes')

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{t('moveNoteTasks.title')}</DialogTitle>
          <DialogDescription>
            {t('moveNoteTasks.description', { count: taskCount, project: projectName })}
          </DialogDescription>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">{t('moveNoteTasks.subtaskNote')}</p>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={isMoving}>
            {t('moveNoteTasks.cancel')}
          </Button>
          <Button onClick={onConfirm} disabled={isMoving}>
            {t('moveNoteTasks.confirm', { count: taskCount })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default MoveNoteTasksDialog
