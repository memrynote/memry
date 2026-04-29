import { useState } from 'react'
import { CheckCircle2 } from '@/lib/icons'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'
import type { Task } from '@/data/sample-tasks'
import { useT } from '@memry/i18n/renderer'

// ============================================================================
// TYPES
// ============================================================================

interface CompleteParentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  parent: Task | null
  incompleteSubtasks: Task[]
  onConfirm: (completeSubtasks: boolean) => void
}

type CompleteOption = 'complete-all' | 'complete-parent-only'

// ============================================================================
// COMPLETE PARENT DIALOG COMPONENT
// ============================================================================

export const CompleteParentDialog = ({
  open,
  onOpenChange,
  parent,
  incompleteSubtasks,
  onConfirm
}: CompleteParentDialogProps): React.JSX.Element | null => {
  const { t: tPhaseF } = useT('tasks')
  const [option, setOption] = useState<CompleteOption>('complete-all')

  if (!parent) return null

  const handleConfirm = (): void => {
    onConfirm(option === 'complete-all')
    onOpenChange(false)
    // Reset option for next time
    setOption('complete-all')
  }

  const handleCancel = (): void => {
    onOpenChange(false)
    setOption('complete-all')
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-primary" />

            {tPhaseF(
              'phaseF.componentsTasksDialogsCompleteParentDialog.completeTaskWithIncompleteSubtasks'
            )}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              <p>
                <span className="font-medium text-foreground">"{parent.title}"</span>{' '}
                {tPhaseF('phaseF.componentsTasksDialogsCompleteParentDialog.has')}
                {incompleteSubtasks.length}{' '}
                {tPhaseF('phaseF.componentsTasksDialogsCompleteParentDialog.incompleteSubtask')}
                {incompleteSubtasks.length !== 1 ? 's' : ''}:
              </p>
              <ul className="space-y-1 text-sm">
                {incompleteSubtasks.slice(0, 5).map((subtask) => (
                  <li key={subtask.id} className="flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50" />
                    <span className="truncate">{subtask.title}</span>
                  </li>
                ))}
                {incompleteSubtasks.length > 5 && (
                  <li className="text-muted-foreground">
                    ...{tPhaseF('phaseF.componentsTasksDialogsCompleteParentDialog.and')}
                    {incompleteSubtasks.length - 5}{' '}
                    {tPhaseF('phaseF.componentsTasksDialogsCompleteParentDialog.more')}
                  </li>
                )}
              </ul>
              <p>
                {tPhaseF('phaseF.componentsTasksDialogsCompleteParentDialog.whatWouldYouLikeToDo')}
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="py-4">
          <RadioGroup
            value={option}
            onValueChange={(value) => setOption(value as CompleteOption)}
            className="space-y-3"
          >
            <div className="flex items-start space-x-3 rounded-sm border p-4 cursor-pointer hover:bg-accent/50 transition-colors">
              <RadioGroupItem value="complete-all" id="complete-all" className="mt-0.5" />
              <Label htmlFor="complete-all" className="cursor-pointer flex-1">
                <div className="font-medium">
                  {tPhaseF(
                    'phaseF.componentsTasksDialogsCompleteParentDialog.completeAllParentSubtasks'
                  )}
                </div>
                <div className="text-sm text-muted-foreground mt-1">
                  {tPhaseF(
                    'phaseF.componentsTasksDialogsCompleteParentDialog.markTheParentAndAllSubtasksAsComplete'
                  )}
                </div>
              </Label>
            </div>

            <div className="flex items-start space-x-3 rounded-sm border p-4 cursor-pointer hover:bg-accent/50 transition-colors">
              <RadioGroupItem
                value="complete-parent-only"
                id="complete-parent-only"
                className="mt-0.5"
              />
              <Label htmlFor="complete-parent-only" className="cursor-pointer flex-1">
                <div className="font-medium">
                  {tPhaseF(
                    'phaseF.componentsTasksDialogsCompleteParentDialog.completeParentOnlyKeepSubtasksIncomplete'
                  )}
                </div>
                <div className="text-sm text-muted-foreground mt-1">
                  {tPhaseF(
                    'phaseF.componentsTasksDialogsCompleteParentDialog.onlyMarkTheParentTaskAsComplete'
                  )}
                </div>
              </Label>
            </div>
          </RadioGroup>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel onClick={handleCancel}>
            {tPhaseF('phaseF.componentsTasksDialogsCompleteParentDialog.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction onClick={handleConfirm}>
            {tPhaseF('phaseF.componentsTasksDialogsCompleteParentDialog.complete')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export default CompleteParentDialog
