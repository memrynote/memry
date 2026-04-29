import { useState } from 'react'
import { AlertTriangle } from '@/lib/icons'

import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { cn } from '@/lib/utils'
import type { Project } from '@/data/tasks-data'
import { useT } from '@memry/i18n/renderer'

// ============================================================================
// TYPES
// ============================================================================

export type DeleteTasksOption = 'move' | 'delete'

interface DeleteProjectDialogProps {
  isOpen: boolean
  onClose: () => void
  onConfirm: (option: DeleteTasksOption) => void
  project: Project | null
}

// ============================================================================
// DELETE PROJECT DIALOG COMPONENT
// ============================================================================

export const DeleteProjectDialog = ({
  isOpen,
  onClose,
  onConfirm,
  project
}: DeleteProjectDialogProps): React.JSX.Element => {
  const { t: tPhaseF } = useT('tasks')
  const [selectedOption, setSelectedOption] = useState<DeleteTasksOption>('move')

  const taskCount = project?.taskCount || 0
  const hasTasks = taskCount > 0

  const handleConfirm = (): void => {
    onConfirm(selectedOption)
    onClose()
  }

  const handleOptionChange = (option: DeleteTasksOption) => (): void => {
    setSelectedOption(option)
  }

  const handleKeyDown =
    (option: DeleteTasksOption) =>
    (e: React.KeyboardEvent): void => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        setSelectedOption(option)
      }
    }

  if (!project) return <></>

  return (
    <AlertDialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            {tPhaseF('phaseF.componentsTasksDeleteProjectDialog.delete')}
            {project.name}"?
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-4">
              {hasTasks ? (
                <>
                  <p>
                    {tPhaseF('phaseF.componentsTasksDeleteProjectDialog.thisProjectHas')}
                    {taskCount} {tPhaseF('phaseF.componentsTasksDeleteProjectDialog.task')}
                    {taskCount !== 1 ? 's' : ''}.{' '}
                    {tPhaseF(
                      'phaseF.componentsTasksDeleteProjectDialog.whatWouldYouLikeToDoWithThem'
                    )}
                  </p>

                  {/* Radio Options */}
                  <div className="space-y-2">
                    {/* Option: Move to Personal */}
                    <label
                      className={cn(
                        'flex cursor-pointer items-center gap-3 rounded-sm border p-3 transition-colors',
                        selectedOption === 'move'
                          ? 'border-primary bg-accent/50'
                          : 'hover:bg-accent/30'
                      )}
                      onClick={handleOptionChange('move')}
                      onKeyDown={handleKeyDown('move')}
                      tabIndex={0}
                      role="radio"
                      aria-checked={selectedOption === 'move'}
                    >
                      <div
                        className={cn(
                          'size-4 rounded-full border-2 transition-colors',
                          selectedOption === 'move'
                            ? 'border-primary bg-primary'
                            : 'border-muted-foreground'
                        )}
                      >
                        {selectedOption === 'move' && (
                          <div className="m-0.5 size-2 rounded-full bg-primary-foreground" />
                        )}
                      </div>
                      <span className="text-sm text-foreground">
                        {tPhaseF(
                          'phaseF.componentsTasksDeleteProjectDialog.moveTasksToPersonalProject'
                        )}
                      </span>
                    </label>

                    {/* Option: Delete tasks */}
                    <label
                      className={cn(
                        'flex cursor-pointer items-center gap-3 rounded-sm border p-3 transition-colors',
                        selectedOption === 'delete'
                          ? 'border-primary bg-accent/50'
                          : 'hover:bg-accent/30'
                      )}
                      onClick={handleOptionChange('delete')}
                      onKeyDown={handleKeyDown('delete')}
                      tabIndex={0}
                      role="radio"
                      aria-checked={selectedOption === 'delete'}
                    >
                      <div
                        className={cn(
                          'size-4 rounded-full border-2 transition-colors',
                          selectedOption === 'delete'
                            ? 'border-primary bg-primary'
                            : 'border-muted-foreground'
                        )}
                      >
                        {selectedOption === 'delete' && (
                          <div className="m-0.5 size-2 rounded-full bg-primary-foreground" />
                        )}
                      </div>
                      <span className="text-sm text-foreground">
                        {tPhaseF(
                          'phaseF.componentsTasksDeleteProjectDialog.deleteAllTasksPermanently'
                        )}
                      </span>
                    </label>
                  </div>
                </>
              ) : (
                <p>
                  {tPhaseF(
                    'phaseF.componentsTasksDeleteProjectDialog.thisProjectHasNoTasksAndWillBePermanentlyDeleted'
                  )}
                </p>
              )}

              {/* Warning */}
              <div className="flex items-center gap-2 rounded-sm bg-destructive/10 p-3 text-sm text-destructive">
                <AlertTriangle className="size-4 shrink-0" />
                <span>
                  {tPhaseF('phaseF.componentsTasksDeleteProjectDialog.thisActionCannotBeUndone')}
                </span>
              </div>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        <AlertDialogFooter>
          <Button variant="outline" onClick={onClose}>
            {tPhaseF('phaseF.componentsTasksDeleteProjectDialog.cancel')}
          </Button>
          <Button variant="destructive" onClick={handleConfirm}>
            {tPhaseF('phaseF.componentsTasksDeleteProjectDialog.deleteProject')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export default DeleteProjectDialog
