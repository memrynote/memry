import { useEffect, useState, useCallback } from "react"
import { motion, AnimatePresence } from "framer-motion"

import { ScrollArea } from "@/components/ui/scroll-area"
import { TaskDetailHeader } from "./task-detail-header"
import { TaskPropertiesGrid } from "./task-properties-grid"
import { TaskDescription } from "./task-description"
import { TaskRepeatDisplay } from "./task-repeat-display"
import { TaskLinksSection } from "./task-links-section"
import { TaskMetadata } from "./task-metadata"
import { TaskDetailFooter } from "./task-detail-footer"
import { DeleteTaskDialog } from "./delete-task-dialog"
import { cn } from "@/lib/utils"
import type { Task, Priority } from "@/data/sample-tasks"
import type { Project } from "@/data/tasks-data"

// ============================================================================
// TYPES
// ============================================================================

interface TaskDetailPanelProps {
  isOpen: boolean
  task: Task | null
  projects: Project[]
  isCompleted: boolean
  onClose: () => void
  onUpdateTask: (taskId: string, updates: Partial<Task>) => void
  onToggleComplete: (taskId: string) => void
  onDeleteTask: (taskId: string) => void
  onDuplicateTask: (taskId: string) => void
  className?: string
}

// ============================================================================
// TASK DETAIL PANEL COMPONENT
// ============================================================================

export const TaskDetailPanel = ({
  isOpen,
  task,
  projects,
  isCompleted,
  onClose,
  onUpdateTask,
  onToggleComplete,
  onDeleteTask,
  onDuplicateTask,
  className,
}: TaskDetailPanelProps): React.JSX.Element => {
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)

  // Handle escape key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && isOpen && !isDeleteDialogOpen) {
        onClose()
      }
    }

    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
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

  const handleToggleRepeat = useCallback((): void => {
    // Placeholder - full repeat config will be built in Prompt 9
    console.log("Toggle repeat config")
  }, [])

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
    console.log("Move to project")
  }, [])

  const handleCopyLink = useCallback((): void => {
    if (task) {
      // Copy task link to clipboard
      const link = `memry://task/${task.id}`
      navigator.clipboard.writeText(link)
      console.log("Link copied:", link)
    }
  }, [task])

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
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ type: "spring", damping: 25, stiffness: 300 }}
              className={cn(
                "fixed right-0 top-0 z-50 flex h-full w-[420px] flex-col bg-background shadow-xl border-l border-border",
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
                  <TaskDescription
                    value={task.description}
                    onChange={handleUpdateDescription}
                  />

                  {/* Divider */}
                  <div className="h-px bg-border" />

                  {/* Repeat */}
                  <TaskRepeatDisplay
                    isRepeating={task.isRepeating}
                    repeatConfig={task.repeatConfig}
                    onToggle={handleToggleRepeat}
                  />

                  {/* Divider */}
                  <div className="h-px bg-border" />

                  {/* Linked Notes */}
                  <TaskLinksSection
                    linkedNoteIds={task.linkedNoteIds}
                    onAddLink={handleAddLink}
                    onRemoveLink={handleRemoveLink}
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
        taskTitle={task?.title || ""}
      />
    </>
  )
}

export default TaskDetailPanel

