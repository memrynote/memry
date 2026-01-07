import { useCallback, useState } from 'react'
import type { DragEndEvent, DragStartEvent, DragOverEvent } from '@dnd-kit/core'
import { toast } from 'sonner'

import type { DragState } from '@/contexts/drag-context'
import {
  formatDateShort,
  startOfDay,
  getDefaultTodoStatus,
  getDefaultDoneStatus
} from '@/lib/task-utils'
import type { Task } from '@/data/sample-tasks'
import type { Project } from '@/data/tasks-data'

// ============================================================================
// TYPES
// ============================================================================

interface UndoAction {
  type: 'move-project' | 'change-status' | 'reschedule' | 'reorder' | 'delete' | 'archive'
  taskIds: string[]
  previousProjectId?: string
  previousStatusId?: string
  previousDates?: Map<string, Date | null>
  previousOrder?: string[]
  sectionId?: string
  deletedTasks?: Task[]
}

interface UseDragHandlersProps {
  tasks: Task[]
  projects: Project[]
  onUpdateTask: (taskId: string, updates: Partial<Task>) => void
  onDeleteTask: (taskId: string) => void
  onReorder?: (sectionId: string, newOrder: string[]) => void
}

interface UseDragHandlersReturn {
  /** Handle drag end event */
  handleDragEnd: (event: DragEndEvent, dragState: DragState) => void
  /** Handle drag start event */
  handleDragStart: (event: DragStartEvent, dragState: DragState) => void
  /** Handle drag over event */
  handleDragOver: (event: DragOverEvent, dragState: DragState) => void
  /** Undo the last drag action */
  undo: () => void
  /** Whether undo is available */
  canUndo: boolean
  /** Last action description for undo toast */
  lastActionDescription: string | null
}

// ============================================================================
// HOOK
// ============================================================================

export const useDragHandlers = ({
  tasks,
  projects,
  onUpdateTask,
  onDeleteTask,
  onReorder
}: UseDragHandlersProps): UseDragHandlersReturn => {
  const [undoStack, setUndoStack] = useState<UndoAction[]>([])
  const [lastActionDescription, setLastActionDescription] = useState<string | null>(null)

  // Record an action for undo
  const recordAction = useCallback((action: UndoAction, description: string) => {
    setUndoStack((prev) => [...prev.slice(-9), action]) // Keep last 10
    setLastActionDescription(description)
  }, [])

  // Undo the last action
  const undo = useCallback(async () => {
    const lastAction = undoStack[undoStack.length - 1]
    if (!lastAction) return

    switch (lastAction.type) {
      case 'move-project':
        if (lastAction.previousProjectId) {
          lastAction.taskIds.forEach((id) => {
            const task = tasks.find((t) => t.id === id)
            if (task) {
              // Find the target project and get default status
              const targetProject = projects.find((p) => p.id === lastAction.previousProjectId)
              const currentProject = projects.find((p) => p.id === task.projectId)
              const currentStatus = currentProject?.statuses.find((s) => s.id === task.statusId)

              // Try to find matching status type in target project
              let newStatusId = task.statusId
              if (targetProject && currentStatus) {
                const matchingStatus = targetProject.statuses.find(
                  (s) => s.type === currentStatus.type
                )
                newStatusId =
                  matchingStatus?.id || getDefaultTodoStatus(targetProject)?.id || task.statusId
              }

              onUpdateTask(id, {
                projectId: lastAction.previousProjectId,
                statusId: newStatusId
              })
            }
          })
        }
        break

      case 'change-status':
        if (lastAction.previousStatusId) {
          lastAction.taskIds.forEach((id) => {
            onUpdateTask(id, { statusId: lastAction.previousStatusId })
          })
        }
        break

      case 'reschedule':
        if (lastAction.previousDates) {
          lastAction.previousDates.forEach((date, taskId) => {
            onUpdateTask(taskId, { dueDate: date })
          })
        }
        break

      case 'reorder':
        if (lastAction.sectionId && lastAction.previousOrder) {
          onReorder?.(lastAction.sectionId, lastAction.previousOrder)
        }
        break

      case 'archive':
        lastAction.taskIds.forEach((id) => {
          onUpdateTask(id, { archivedAt: null })
        })
        break
    }

    setUndoStack((prev) => prev.slice(0, -1))
    toast.success('Undone')
  }, [undoStack, tasks, projects, onUpdateTask, onReorder])

  // Handle dropping on a section (reschedule)
  const handleSectionDrop = useCallback(
    (taskIds: string[], targetDate: Date | null, sectionLabel: string) => {
      // Store previous dates for undo
      const previousDates = new Map<string, Date | null>()
      taskIds.forEach((id) => {
        const task = tasks.find((t) => t.id === id)
        previousDates.set(id, task?.dueDate || null)
      })

      // Update all tasks
      taskIds.forEach((id) => {
        onUpdateTask(id, { dueDate: targetDate })
      })

      // Record for undo
      recordAction(
        {
          type: 'reschedule',
          taskIds,
          previousDates
        },
        `Rescheduled to ${sectionLabel}`
      )

      toast.success(
        taskIds.length === 1
          ? `Rescheduled to ${sectionLabel}`
          : `${taskIds.length} tasks rescheduled to ${sectionLabel}`
      )
    },
    [tasks, onUpdateTask, recordAction]
  )

  // Handle dropping on a Kanban column (status change)
  const handleColumnDrop = useCallback(
    (taskIds: string[], targetColumnId: string, targetProject: Project) => {
      const targetStatus = targetProject.statuses.find((s) => s.id === targetColumnId)
      if (!targetStatus) return

      // Store previous status for undo (using first task's status)
      const firstTask = tasks.find((t) => taskIds.includes(t.id))
      const previousStatusId = firstTask?.statusId

      // Update all tasks
      taskIds.forEach((id) => {
        const task = tasks.find((t) => t.id === id)
        if (!task) return

        const updates: Partial<Task> = {
          statusId: targetColumnId
        }

        // Handle completion
        if (targetStatus.type === 'done' && !task.completedAt) {
          updates.completedAt = new Date()
        } else if (targetStatus.type !== 'done' && task.completedAt) {
          updates.completedAt = null
        }

        onUpdateTask(id, updates)
      })

      // Record for undo
      if (previousStatusId) {
        recordAction(
          {
            type: 'change-status',
            taskIds,
            previousStatusId
          },
          `Moved to ${targetStatus.name}`
        )
      }

      toast.success(
        taskIds.length === 1
          ? `Moved to ${targetStatus.name}`
          : `${taskIds.length} tasks moved to ${targetStatus.name}`
      )
    },
    [tasks, onUpdateTask, recordAction]
  )

  // Handle dropping on a date cell (calendar)
  const handleDateDrop = useCallback(
    (taskIds: string[], targetDate: Date) => {
      // Store previous dates for undo
      const previousDates = new Map<string, Date | null>()
      taskIds.forEach((id) => {
        const task = tasks.find((t) => t.id === id)
        previousDates.set(id, task?.dueDate || null)
      })

      // Update all tasks
      taskIds.forEach((id) => {
        const task = tasks.find((t) => t.id === id)
        // Preserve time if set
        let newDueDate = startOfDay(targetDate)
        if (task?.dueTime) {
          const [hours, minutes] = task.dueTime.split(':').map(Number)
          newDueDate = new Date(newDueDate)
          newDueDate.setHours(hours, minutes)
        }
        onUpdateTask(id, { dueDate: newDueDate })
      })

      // Record for undo
      recordAction(
        {
          type: 'reschedule',
          taskIds,
          previousDates
        },
        `Rescheduled to ${formatDateShort(targetDate)}`
      )

      toast.success(
        taskIds.length === 1
          ? `Rescheduled to ${formatDateShort(targetDate)}`
          : `${taskIds.length} tasks rescheduled to ${formatDateShort(targetDate)}`
      )
    },
    [tasks, onUpdateTask, recordAction]
  )

  // Handle dropping on a project (change project)
  const handleProjectDrop = useCallback(
    (taskIds: string[], targetProjectId: string) => {
      const targetProject = projects.find((p) => p.id === targetProjectId)
      if (!targetProject) return

      // Store previous project for undo (using first task's project)
      const firstTask = tasks.find((t) => taskIds.includes(t.id))
      const previousProjectId = firstTask?.projectId

      // Update all tasks
      taskIds.forEach((id) => {
        const task = tasks.find((t) => t.id === id)
        if (!task) return

        // Find current status type and map to new project
        const currentProject = projects.find((p) => p.id === task.projectId)
        const currentStatus = currentProject?.statuses.find((s) => s.id === task.statusId)
        const currentStatusType = currentStatus?.type || 'todo'

        // Find matching status in target project
        let newStatus = targetProject.statuses.find((s) => s.type === currentStatusType)
        if (!newStatus) {
          newStatus = getDefaultTodoStatus(targetProject)
        }

        onUpdateTask(id, {
          projectId: targetProjectId,
          statusId: newStatus?.id || targetProject.statuses[0]?.id
        })
      })

      // Record for undo
      if (previousProjectId) {
        recordAction(
          {
            type: 'move-project',
            taskIds,
            previousProjectId
          },
          `Moved to ${targetProject.name}`
        )
      }

      toast.success(
        taskIds.length === 1
          ? `Moved to ${targetProject.name}`
          : `${taskIds.length} tasks moved to ${targetProject.name}`
      )
    },
    [tasks, projects, onUpdateTask, recordAction]
  )

  // Handle dropping on trash (delete)
  const handleTrashDrop = useCallback(
    (taskIds: string[]) => {
      const tasksToDelete = tasks.filter((t) => taskIds.includes(t.id))

      taskIds.forEach((id) => {
        onDeleteTask(id)
      })

      toast.success(taskIds.length === 1 ? 'Task deleted' : `${taskIds.length} tasks deleted`, {
        action: {
          label: 'Undo',
          onClick: () => {
            // Note: This is a simplified undo - actual implementation would
            // need to re-create the tasks
            toast.info('Undo not available for delete')
          }
        }
      })
    },
    [tasks, onDeleteTask]
  )

  // Handle dropping on archive
  const handleArchiveDrop = useCallback(
    (taskIds: string[]) => {
      taskIds.forEach((id) => {
        onUpdateTask(id, { archivedAt: new Date() })
      })

      // Record for undo
      recordAction(
        {
          type: 'archive',
          taskIds
        },
        `Archived ${taskIds.length} task${taskIds.length !== 1 ? 's' : ''}`
      )

      toast.success(taskIds.length === 1 ? 'Task archived' : `${taskIds.length} tasks archived`, {
        duration: 10000, // T052: 10-second timeout for undo per spec
        action: {
          label: 'Undo',
          onClick: undo
        }
      })
    },
    [onUpdateTask, recordAction, undo]
  )

  // Main drag end handler
  const handleDragEnd = useCallback(
    (event: DragEndEvent, dragState: DragState) => {
      const { over } = event

      if (!over) return

      const overData = over.data.current
      const overType = overData?.type
      const taskIds = dragState.activeIds

      switch (overType) {
        case 'task': {
          // Check if we're dropping within the same section (reorder) or different section (move)
          const overSectionId = overData?.sectionId
          const sourceSectionId = dragState.sourceContainerId

          // Only reorder if dropping within the same section
          if (
            overSectionId &&
            sourceSectionId &&
            overSectionId === sourceSectionId &&
            taskIds.length === 1
          ) {
            // Same section - this is a reorder operation
            // Pass the reorder to the callback which should handle it via useTaskOrder
            onReorder?.(overSectionId, [taskIds[0], over.id as string])
          } else if (overSectionId && overSectionId !== sourceSectionId) {
            // Different section - treat as a section drop (change due date)
            // Get the date from the over task's section if available
            const overTask = overData?.task as Task | undefined
            if (overTask?.dueDate) {
              handleSectionDrop(taskIds, overTask.dueDate, overSectionId)
            }
          }
          break
        }

        case 'section': {
          const targetDate = overData?.date as Date | null
          const sectionLabel = overData?.label as string
          handleSectionDrop(taskIds, targetDate, sectionLabel)
          break
        }

        case 'column': {
          const targetColumnId = overData?.columnId || over.id
          const project =
            overData?.project ||
            projects.find((p) => p.statuses.some((s) => s.id === targetColumnId))
          if (project) {
            handleColumnDrop(taskIds, targetColumnId as string, project)
          }
          break
        }

        case 'date': {
          const targetDate = overData?.date as Date
          if (targetDate) {
            handleDateDrop(taskIds, targetDate)
          }
          break
        }

        case 'project': {
          const targetProjectId = overData?.projectId as string
          if (targetProjectId) {
            handleProjectDrop(taskIds, targetProjectId)
          }
          break
        }

        case 'trash': {
          handleTrashDrop(taskIds)
          break
        }

        case 'archive': {
          handleArchiveDrop(taskIds)
          break
        }
      }
    },
    [
      tasks,
      projects,
      onReorder,
      handleSectionDrop,
      handleColumnDrop,
      handleDateDrop,
      handleProjectDrop,
      handleTrashDrop,
      handleArchiveDrop
    ]
  )

  // Drag start handler (for logging/analytics)
  const handleDragStart = useCallback((event: DragStartEvent, dragState: DragState) => {
    // Can be used for analytics or additional setup
  }, [])

  // Drag over handler (for visual feedback)
  const handleDragOver = useCallback((event: DragOverEvent, dragState: DragState) => {
    // Can be used for additional visual feedback
  }, [])

  return {
    handleDragEnd,
    handleDragStart,
    handleDragOver,
    undo,
    canUndo: undoStack.length > 0,
    lastActionDescription
  }
}

export default useDragHandlers
