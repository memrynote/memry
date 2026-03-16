import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'

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
            Delete "{project.name}"?
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-4">
              {hasTasks ? (
                <>
                  <p>
                    This project has {taskCount} task{taskCount !== 1 ? 's' : ''}. What would you
                    like to do with them?
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
                        Move tasks to Personal project
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
                      <span className="text-sm text-foreground">Delete all tasks permanently</span>
                    </label>
                  </div>
                </>
              ) : (
                <p>This project has no tasks and will be permanently deleted.</p>
              )}

              {/* Warning */}
              <div className="flex items-center gap-2 rounded-sm bg-destructive/10 p-3 text-sm text-destructive">
                <AlertTriangle className="size-4 shrink-0" />
                <span>This action cannot be undone.</span>
              </div>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        <AlertDialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleConfirm}>
            Delete Project
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export default DeleteProjectDialog
