import { useEffect, useState, useCallback, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

import { ScrollArea } from '@/components/ui/scroll-area'
import { useTabs } from '@/contexts/tabs'
import { TaskDetailHeader } from './task-detail-header'
import { TaskPropertiesGrid } from './task-properties-grid'
import { TaskDescription } from './task-description'
import { TaskRepeatDisplay } from './task-repeat-display'
import { TaskLinksSection } from './task-links-section'
import { TaskMetadata } from './task-metadata'
import { TaskDetailFooter } from './task-detail-footer'
import { DeleteTaskDialog } from './delete-task-dialog'
import { StopRepeatingDialog, type StopRepeatOption } from './stop-repeating-dialog'
import { SubtasksSection } from './detail-panel'
import { cn } from '@/lib/utils'
import { getSubtasks, calculateProgress, canHaveSubtasks } from '@/lib/subtask-utils'
import { notesService } from '@/services/notes-service'
import type { Task, Priority, RepeatConfig } from '@/data/sample-tasks'
import type { Project } from '@/data/tasks-data'
import { createLogger } from '@/lib/logger'

const log = createLogger('Component:TaskDetailPanel')

// ============================================================================
// TYPES
// ============================================================================

interface TaskDetailPanelProps {
  isOpen: boolean
  task: Task | null
  allTasks: Task[]
  projects: Project[]
  isCompleted: boolean
  onClose: () => void
  onUpdateTask: (taskId: string, updates: Partial<Task>) => void
  onToggleComplete: (taskId: string) => void
  onDeleteTask: (taskId: string) => void
  onDuplicateTask: (taskId: string) => void
  onSkipOccurrence?: (taskId: string) => void
  onStopRepeating?: (taskId: string, option: StopRepeatOption) => void
  // Subtask management props
  onAddSubtask?: (parentId: string, title: string) => void
  onBulkAddSubtasks?: (parentId: string, titles: string[]) => void
  onUpdateSubtask?: (subtaskId: string, updates: Partial<Task>) => void
  onToggleSubtaskComplete?: (subtaskId: string) => void
  onDeleteSubtask?: (subtaskId: string) => void
  onReorderSubtasks?: (parentId: string, newOrder: string[]) => void
  onPromoteSubtask?: (subtaskId: string) => void
  // Bulk subtask operations
  onCompleteAllSubtasks?: (parentId: string) => void
  onMarkAllSubtasksIncomplete?: (parentId: string) => void
  onOpenBulkDueDateDialog?: (parentId: string) => void
  onOpenBulkPriorityDialog?: (parentId: string) => void
  onOpenDeleteAllSubtasksDialog?: (parentId: string) => void
  className?: string
}

// ============================================================================
// TASK DETAIL PANEL COMPONENT
// ============================================================================

export const TaskDetailPanel = ({
  isOpen,
  task,
  allTasks,
  projects,
  isCompleted,
  onClose,
  onUpdateTask,
  onToggleComplete,
  onDeleteTask,
  onDuplicateTask,
  onSkipOccurrence,
  onStopRepeating,
  onAddSubtask,
  onBulkAddSubtasks,
  onUpdateSubtask,
  onToggleSubtaskComplete,
  onDeleteSubtask,
  onReorderSubtasks,
  onPromoteSubtask,
  onCompleteAllSubtasks,
  onMarkAllSubtasksIncomplete,
  onOpenBulkDueDateDialog,
  onOpenBulkPriorityDialog,
  onOpenDeleteAllSubtasksDialog,
  className
}: TaskDetailPanelProps): React.JSX.Element => {
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const [isStopRepeatDialogOpen, setIsStopRepeatDialogOpen] = useState(false)
  const { openTab } = useTabs()

  // Calculate subtasks and progress
  const subtasks = useMemo(() => {
    if (!task) return []
    return getSubtasks(task.id, allTasks)
  }, [task, allTasks])

  const subtaskProgress = useMemo(() => {
    return calculateProgress(subtasks)
  }, [subtasks])

  // Check if task can have subtasks (top-level tasks only)
  const showSubtasksSection = task ? canHaveSubtasks(task) : false

  // Handle escape key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && isOpen && !isDeleteDialogOpen) {
        onClose()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, isDeleteDialogOpen, onClose])

  // Update handlers
  const handleTitleChange = useCallback(
    (title: string): void => {
      if (task) {
        onUpdateTask(task.id, { title })
      }
    },
    [task, onUpdateTask]
  )

  const handleToggleComplete = useCallback((): void => {
    if (task) {
      onToggleComplete(task.id)
    }
  }, [task, onToggleComplete])

  const handleUpdateProject = useCallback(
    (projectId: string): void => {
      if (task) {
        onUpdateTask(task.id, { projectId })
      }
    },
    [task, onUpdateTask]
  )

  const handleUpdateStatus = useCallback(
    (statusId: string): void => {
      if (task) {
        onUpdateTask(task.id, { statusId })
      }
    },
    [task, onUpdateTask]
  )

  const handleUpdateDueDate = useCallback(
    (dueDate: Date | null): void => {
      if (task) {
        onUpdateTask(task.id, { dueDate })
      }
    },
    [task, onUpdateTask]
  )

  const handleUpdateDueTime = useCallback(
    (dueTime: string | null): void => {
      if (task) {
        onUpdateTask(task.id, { dueTime })
      }
    },
    [task, onUpdateTask]
  )

  const handleUpdatePriority = useCallback(
    (priority: Priority): void => {
      if (task) {
        onUpdateTask(task.id, { priority })
      }
    },
    [task, onUpdateTask]
  )

  const handleUpdateDescription = useCallback(
    (description: string): void => {
      if (task) {
        onUpdateTask(task.id, { description })
      }
    },
    [task, onUpdateTask]
  )

  const handleRepeatConfigChange = useCallback(
    (repeatConfig: RepeatConfig | null): void => {
      if (task) {
        onUpdateTask(task.id, {
          isRepeating: repeatConfig !== null,
          repeatConfig
        })
      }
    },
    [task, onUpdateTask]
  )

  const handleSkipOccurrence = useCallback((): void => {
    if (task && onSkipOccurrence) {
      onSkipOccurrence(task.id)
    }
  }, [task, onSkipOccurrence])

  const handleStopRepeatClick = useCallback((): void => {
    setIsStopRepeatDialogOpen(true)
  }, [])

  const handleStopRepeatConfirm = useCallback(
    (option: StopRepeatOption): void => {
      if (task && onStopRepeating) {
        onStopRepeating(task.id, option)
      }
      setIsStopRepeatDialogOpen(false)
    },
    [task, onStopRepeating]
  )

  const handleAddLink = useCallback(
    (noteId: string): void => {
      if (task) {
        const newLinkedNoteIds = [...task.linkedNoteIds, noteId]
        onUpdateTask(task.id, { linkedNoteIds: newLinkedNoteIds })
      }
    },
    [task, onUpdateTask]
  )

  const handleRemoveLink = useCallback(
    (noteId: string): void => {
      if (task) {
        const newLinkedNoteIds = task.linkedNoteIds.filter((id) => id !== noteId)
        onUpdateTask(task.id, { linkedNoteIds: newLinkedNoteIds })
      }
    },
    [task, onUpdateTask]
  )

  const handleNoteClick = useCallback(
    async (noteId: string): Promise<void> => {
      // Try to get the note title for a better tab name
      let noteTitle = 'Note'
      try {
        const note = await notesService.get(noteId)
        if (note) {
          noteTitle = note.title
        }
      } catch {
        // Fall back to generic title
      }

      openTab({
        type: 'note',
        title: noteTitle,
        icon: 'file-text',
        path: `/notes/${noteId}`,
        entityId: noteId,
        isPinned: false,
        isModified: false,
        isPreview: true,
        isDeleted: false
      })
    },
    [openTab]
  )

  const handleDelete = useCallback((): void => {
    setIsDeleteDialogOpen(true)
  }, [])

  const handleConfirmDelete = useCallback((): void => {
    if (task) {
      onDeleteTask(task.id)
    }
    setIsDeleteDialogOpen(false)
  }, [task, onDeleteTask])

  const handleDuplicate = useCallback((): void => {
    if (task) {
      onDuplicateTask(task.id)
    }
  }, [task, onDuplicateTask])

  const handleMoveToProject = useCallback((): void => {
    // Opens project selector - for now just log
    log.info('Move to project')
  }, [])

  const handleCopyLink = useCallback((): void => {
    if (task) {
      // Copy task link to clipboard
      const link = `memry://task/${task.id}`
      navigator.clipboard.writeText(link)
      log.info('Link copied:', link)
    }
  }, [task])

  // Subtask handlers
  const handleAddSubtask = useCallback(
    (parentId: string, title: string): void => {
      onAddSubtask?.(parentId, title)
    },
    [onAddSubtask]
  )

  const handleBulkAddSubtasks = useCallback(
    (parentId: string, titles: string[]): void => {
      onBulkAddSubtasks?.(parentId, titles)
    },
    [onBulkAddSubtasks]
  )

  const handleUpdateSubtask = useCallback(
    (subtaskId: string, updates: Partial<Task>): void => {
      onUpdateSubtask?.(subtaskId, updates)
    },
    [onUpdateSubtask]
  )

  const handleDeleteSubtask = useCallback(
    (subtaskId: string): void => {
      onDeleteSubtask?.(subtaskId)
    },
    [onDeleteSubtask]
  )

  const handleReorderSubtasks = useCallback(
    (parentId: string, newOrder: string[]): void => {
      onReorderSubtasks?.(parentId, newOrder)
    },
    [onReorderSubtasks]
  )

  const handlePromoteSubtask = useCallback(
    (subtaskId: string): void => {
      onPromoteSubtask?.(subtaskId)
    },
    [onPromoteSubtask]
  )

  const handleToggleSubtaskComplete = useCallback(
    (subtaskId: string): void => {
      onToggleSubtaskComplete?.(subtaskId)
    },
    [onToggleSubtaskComplete]
  )

  // Bulk subtask operation handlers
  const handleCompleteAllSubtasks = useCallback(
    (parentId: string): void => {
      onCompleteAllSubtasks?.(parentId)
    },
    [onCompleteAllSubtasks]
  )

  const handleMarkAllSubtasksIncomplete = useCallback(
    (parentId: string): void => {
      onMarkAllSubtasksIncomplete?.(parentId)
    },
    [onMarkAllSubtasksIncomplete]
  )

  const handleOpenBulkDueDateDialog = useCallback(
    (parentId: string): void => {
      onOpenBulkDueDateDialog?.(parentId)
    },
    [onOpenBulkDueDateDialog]
  )

  const handleOpenBulkPriorityDialog = useCallback(
    (parentId: string): void => {
      onOpenBulkPriorityDialog?.(parentId)
    },
    [onOpenBulkPriorityDialog]
  )

  const handleOpenDeleteAllSubtasksDialog = useCallback(
    (parentId: string): void => {
      onOpenDeleteAllSubtasksDialog?.(parentId)
    },
    [onOpenDeleteAllSubtasksDialog]
  )

  return (
    <>
      <AnimatePresence>
        {isOpen && task && (
          <>
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 z-40 bg-black/20"
              onClick={onClose}
              aria-hidden="true"
            />

            {/* Panel */}
            <motion.aside
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
              className={cn(
                'fixed right-0 top-0 z-50 flex h-full w-[420px] flex-col bg-background shadow-xl border-l border-border',
                className
              )}
              role="dialog"
              aria-modal="true"
              aria-label="Task details"
            >
              {/* Header */}
              <TaskDetailHeader
                title={task.title}
                isCompleted={isCompleted}
                onTitleChange={handleTitleChange}
                onToggleComplete={handleToggleComplete}
                onClose={onClose}
              />

              {/* Scrollable content */}
              <ScrollArea className="flex-1">
                <div className="flex flex-col gap-6 p-4">
                  {/* Properties Grid */}
                  <TaskPropertiesGrid
                    task={task}
                    projects={projects}
                    isCompleted={isCompleted}
                    onUpdateProject={handleUpdateProject}
                    onUpdateStatus={handleUpdateStatus}
                    onUpdateDueDate={handleUpdateDueDate}
                    onUpdateDueTime={handleUpdateDueTime}
                    onUpdatePriority={handleUpdatePriority}
                  />

                  {/* Divider */}
                  <div className="h-px bg-border" />

                  {/* Description */}
                  <TaskDescription value={task.description} onChange={handleUpdateDescription} />

                  {/* Divider */}
                  <div className="h-px bg-border" />

                  {/* Subtasks Section (only for top-level tasks) */}
                  {showSubtasksSection && onAddSubtask && (
                    <>
                      <SubtasksSection
                        parentTask={task}
                        subtasks={subtasks}
                        progress={subtaskProgress}
                        onAddSubtask={handleAddSubtask}
                        onBulkAddSubtasks={handleBulkAddSubtasks}
                        onUpdateSubtask={handleUpdateSubtask}
                        onToggleSubtaskComplete={handleToggleSubtaskComplete}
                        onDeleteSubtask={handleDeleteSubtask}
                        onReorderSubtasks={handleReorderSubtasks}
                        onPromoteSubtask={handlePromoteSubtask}
                        onCompleteAllSubtasks={handleCompleteAllSubtasks}
                        onMarkAllSubtasksIncomplete={handleMarkAllSubtasksIncomplete}
                        onOpenBulkDueDateDialog={handleOpenBulkDueDateDialog}
                        onOpenBulkPriorityDialog={handleOpenBulkPriorityDialog}
                        onOpenDeleteAllSubtasksDialog={handleOpenDeleteAllSubtasksDialog}
                      />

                      {/* Divider */}
                      <div className="h-px bg-border" />
                    </>
                  )}

                  {/* Repeat */}
                  <TaskRepeatDisplay
                    isRepeating={task.isRepeating}
                    repeatConfig={task.repeatConfig}
                    dueDate={task.dueDate}
                    onConfigChange={handleRepeatConfigChange}
                    onSkipOccurrence={
                      task.isRepeating && onSkipOccurrence ? handleSkipOccurrence : undefined
                    }
                  />

                  {/* Divider */}
                  <div className="h-px bg-border" />

                  {/* Linked Notes */}
                  <TaskLinksSection
                    linkedNoteIds={task.linkedNoteIds}
                    onAddLink={handleAddLink}
                    onRemoveLink={handleRemoveLink}
                    onNoteClick={handleNoteClick}
                  />

                  {/* Divider */}
                  <div className="h-px bg-border" />

                  {/* Metadata */}
                  <TaskMetadata
                    createdAt={task.createdAt}
                    completedAt={task.completedAt}
                    sourceNoteId={task.sourceNoteId}
                  />
                </div>
              </ScrollArea>

              {/* Footer */}
              <TaskDetailFooter
                onDelete={handleDelete}
                onDuplicate={handleDuplicate}
                onMoveToProject={handleMoveToProject}
                onCopyLink={handleCopyLink}
              />
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* Delete Confirmation Dialog */}
      <DeleteTaskDialog
        isOpen={isDeleteDialogOpen}
        onClose={() => setIsDeleteDialogOpen(false)}
        onConfirm={handleConfirmDelete}
        taskTitle={task?.title || ''}
      />

      {/* Stop Repeating Dialog */}
      <StopRepeatingDialog
        isOpen={isStopRepeatDialogOpen}
        onClose={() => setIsStopRepeatDialogOpen(false)}
        onConfirm={handleStopRepeatConfirm}
        taskTitle={task?.title || ''}
        repeatConfig={task?.repeatConfig || null}
      />
    </>
  )
}

export default TaskDetailPanel
