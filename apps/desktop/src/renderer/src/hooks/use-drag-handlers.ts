import { useCallback, useRef, useState } from 'react'
import type { DragEndEvent, DragStartEvent, DragOverEvent } from '@dnd-kit/core'
import { arrayMove } from '@dnd-kit/sortable'
import { toast } from 'sonner'

import type { DragState } from '@/contexts/drag-context'
import { formatDateShort, startOfDay, getDefaultTodoStatus } from '@/lib/task-utils'
import { resolveColumnDrop } from '@/lib/kanban-drop-resolver'
import type { Task, Priority } from '@/data/sample-tasks'
import type { Project } from '@/data/tasks-data'

// ============================================================================
// TYPES
// ============================================================================

interface UndoAction {
  type:
    | 'move-project'
    | 'change-status'
    | 'change-priority'
    | 'reschedule'
    | 'reorder'
    | 'delete'
    | 'archive'
  taskIds: string[]
  previousProjectId?: string
  previousStatusId?: string
  previousStatusIds?: Map<string, string>
  previousPriorities?: Map<string, Priority>
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
  handleDragEnd: (event: DragEndEvent, dragState: DragState) => void
  handleDragStart: (event: DragStartEvent, dragState: DragState) => void
  handleDragOver: (event: DragOverEvent, dragState: DragState) => void
  undo: () => void
  canUndo: boolean
  lastActionDescription: string | null
  droppedPriorities: Map<string, Priority>
}

const buildReorderedTaskIds = (
  sectionTaskIds: string[] | undefined,
  activeId: string,
  overId: string
): string[] => {
  if (!sectionTaskIds || sectionTaskIds.length === 0) {
    return [activeId, overId]
  }

  const currentOrder = Array.from(new Set(sectionTaskIds))
  const oldIndex = currentOrder.indexOf(activeId)
  const newIndex = currentOrder.indexOf(overId)

  if (newIndex === -1) {
    return currentOrder
  }

  if (oldIndex === -1) {
    const nextOrder = [...currentOrder]
    nextOrder.splice(newIndex, 0, activeId)
    return nextOrder
  }

  return arrayMove(currentOrder, oldIndex, newIndex)
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
  const [droppedPriorities, setDroppedPriorities] = useState<Map<string, Priority>>(new Map())
  const priorityTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

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
        if (lastAction.previousStatusIds) {
          lastAction.previousStatusIds.forEach((statusId, taskId) => {
            onUpdateTask(taskId, { statusId })
          })
        } else if (lastAction.previousStatusId) {
          lastAction.taskIds.forEach((id) => {
            onUpdateTask(id, { statusId: lastAction.previousStatusId })
          })
        }
        break

      case 'change-priority':
        if (lastAction.previousPriorities) {
          lastAction.previousPriorities.forEach((priority, taskId) => {
            onUpdateTask(taskId, { priority })
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

  // Handle dropping on a priority column
  const handlePriorityDrop = useCallback(
    (taskIds: string[], priority: Priority) => {
      const previousPriorities = new Map<string, Priority>()
      taskIds.forEach((id) => {
        const task = tasks.find((t) => t.id === id)
        if (task) previousPriorities.set(id, task.priority)
      })

      taskIds.forEach((id) => {
        onUpdateTask(id, { priority })
      })

      const label =
        priority === 'none' ? 'No Priority' : priority.charAt(0).toUpperCase() + priority.slice(1)

      recordAction(
        { type: 'change-priority', taskIds, previousPriorities },
        `Priority set to ${label}`
      )

      const newDropped = new Map<string, Priority>()
      taskIds.forEach((id) => newDropped.set(id, priority))
      setDroppedPriorities(newDropped)

      if (priorityTimerRef.current) clearTimeout(priorityTimerRef.current)
      priorityTimerRef.current = setTimeout(() => setDroppedPriorities(new Map()), 2500)

      toast.success(
        taskIds.length === 1
          ? `Priority set to ${label}`
          : `${taskIds.length} tasks set to ${label}`
      )
    },
    [tasks, onUpdateTask, recordAction]
  )

  // Handle dropping on a canonical status column (todo/in_progress/done without project context)
  const handleCanonicalStatusDrop = useCallback(
    (taskIds: string[], statusType: 'todo' | 'in_progress' | 'done') => {
      const previousStatusIds = new Map<string, string>()

      taskIds.forEach((id) => {
        const task = tasks.find((t) => t.id === id)
        if (!task) return

        previousStatusIds.set(id, task.statusId)

        const taskProject = projects.find((p) => p.id === task.projectId)
        if (!taskProject) return

        const targetStatus = taskProject.statuses.find((s) => s.type === statusType)
        if (!targetStatus) return

        const updates: Partial<Task> = { statusId: targetStatus.id }

        if (targetStatus.type === 'done' && !task.completedAt) {
          updates.completedAt = new Date()
        } else if (targetStatus.type !== 'done' && task.completedAt) {
          updates.completedAt = null
        }

        onUpdateTask(id, updates)
      })

      const statusLabels: Record<string, string> = {
        todo: 'To Do',
        in_progress: 'In Progress',
        done: 'Done'
      }
      const label = statusLabels[statusType]

      recordAction({ type: 'change-status', taskIds, previousStatusIds }, `Moved to ${label}`)

      toast.success(
        taskIds.length === 1 ? `Moved to ${label}` : `${taskIds.length} tasks moved to ${label}`
      )
    },
    [tasks, projects, onUpdateTask, recordAction]
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
          const overSectionId = overData?.sectionId
          const overSectionTaskIds = overData?.sectionTaskIds as string[] | undefined
          const overColumnId = overData?.columnId
          const sourceSectionId = dragState.sourceContainerId

          if (
            overSectionId &&
            sourceSectionId &&
            overSectionId === sourceSectionId &&
            taskIds.length === 1
          ) {
            onReorder?.(
              overSectionId,
              buildReorderedTaskIds(overSectionTaskIds, taskIds[0], over.id as string)
            )
          } else if (
            overColumnId &&
            sourceSectionId &&
            overColumnId === sourceSectionId &&
            taskIds.length === 1
          ) {
            onReorder?.(
              overColumnId,
              buildReorderedTaskIds(overSectionTaskIds, taskIds[0], over.id as string)
            )
          } else if (overColumnId) {
            const result = resolveColumnDrop(overColumnId, projects)
            if (result) {
              switch (result.type) {
                case 'priority':
                  handlePriorityDrop(taskIds, result.priority)
                  break
                case 'dueDate':
                  handleSectionDrop(taskIds, result.dueDate, result.bucketLabel)
                  break
                case 'project':
                  handleProjectDrop(taskIds, result.projectId)
                  break
                case 'canonicalStatus':
                  handleCanonicalStatusDrop(taskIds, result.statusType)
                  break
                case 'projectStatus':
                  handleColumnDrop(taskIds, result.columnId, result.project)
                  break
              }
            }
          } else if (overSectionId && overSectionId !== sourceSectionId) {
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
          const targetColumnId = (overData?.columnId || over.id) as string
          if (targetColumnId === dragState.sourceContainerId) break

          const result = resolveColumnDrop(targetColumnId, projects)
          if (!result) break

          switch (result.type) {
            case 'priority':
              handlePriorityDrop(taskIds, result.priority)
              break
            case 'dueDate':
              handleSectionDrop(taskIds, result.dueDate, result.bucketLabel)
              break
            case 'project':
              handleProjectDrop(taskIds, result.projectId)
              break
            case 'canonicalStatus':
              handleCanonicalStatusDrop(taskIds, result.statusType)
              break
            case 'projectStatus':
              handleColumnDrop(taskIds, result.columnId, result.project)
              break
          }
          break
        }

        case 'weekday': {
          const weekdayDate = overData?.date as Date | undefined
          const weekdayLabel = overData?.label as string
          if (weekdayDate) {
            handleSectionDrop(taskIds, weekdayDate, weekdayLabel)
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
      handlePriorityDrop,
      handleCanonicalStatusDrop,
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
    lastActionDescription,
    droppedPriorities
  }
}

export default useDragHandlers
