import { useCallback, useRef, useState } from 'react'
import type { DragEndEvent, DragStartEvent, DragOverEvent } from '@dnd-kit/core'
import { arrayMove } from '@dnd-kit/sortable'
import { toast } from 'sonner'

import { resolveTaskEdgeFromDndEvent, type DragState } from '@/contexts/drag-context'
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
    | 'cross-section-move'
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
  previousOrderUpdates?: Record<string, string[] | null>
  previousTaskState?: Map<string, Partial<Task>>
  sectionId?: string
  deletedTasks?: Task[]
}

interface UseDragHandlersProps {
  tasks: Task[]
  projects: Project[]
  onUpdateTask: (taskId: string, updates: Partial<Task>) => void
  onDeleteTask: (taskId: string) => void
  onReorder?: (updates: Record<string, string[] | null>) => void
  getOrder?: (sectionId: string) => string[] | undefined
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
  overId: string,
  overTaskEdge: DragState['overTaskEdge'] = null
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
    nextOrder.splice(overTaskEdge === 'after' ? newIndex + 1 : newIndex, 0, activeId)
    return nextOrder
  }

  if (overTaskEdge !== 'after') {
    return arrayMove(currentOrder, oldIndex, newIndex)
  }

  const withoutActive = currentOrder.filter((id) => id !== activeId)
  const overIndexAfterRemoval = withoutActive.indexOf(overId)
  if (overIndexAfterRemoval === -1) {
    return currentOrder
  }

  const nextOrder = [...withoutActive]
  nextOrder.splice(overIndexAfterRemoval + 1, 0, activeId)
  return nextOrder
}

const buildCrossSectionOrderUpdates = ({
  activeIds,
  sourceSectionId,
  sourceSectionTaskIds,
  targetSectionId,
  targetSectionTaskIds,
  overId,
  overTaskEdge,
  sectionDropPosition
}: {
  activeIds: string[]
  sourceSectionId: string
  sourceSectionTaskIds: string[] | undefined
  targetSectionId: string
  targetSectionTaskIds: string[] | undefined
  overId: string | null
  overTaskEdge: DragState['overTaskEdge']
  sectionDropPosition: DragState['sectionDropPosition']
}): Record<string, string[]> => {
  const draggedIds = Array.from(new Set(activeIds))
  const sourceOrder = (sourceSectionTaskIds ?? []).filter((id) => !draggedIds.includes(id))
  const targetOrder = (targetSectionTaskIds ?? []).filter((id) => !draggedIds.includes(id))

  let insertIndex = targetOrder.length

  if (sectionDropPosition === 'start') {
    insertIndex = 0
  } else if (sectionDropPosition === 'end') {
    insertIndex = targetOrder.length
  } else if (overId) {
    const overIndex = targetOrder.indexOf(overId)
    if (overIndex !== -1) {
      insertIndex = overTaskEdge === 'after' ? overIndex + 1 : overIndex
    }
  }

  const nextTargetOrder = [...targetOrder]
  nextTargetOrder.splice(insertIndex, 0, ...draggedIds)

  return {
    [sourceSectionId]: sourceOrder,
    [targetSectionId]: nextTargetOrder
  }
}

// ============================================================================
// HOOK
// ============================================================================

export const useDragHandlers = ({
  tasks,
  projects,
  onUpdateTask,
  onDeleteTask,
  onReorder,
  getOrder
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
          onReorder?.({ [lastAction.sectionId]: lastAction.previousOrder })
        }
        break

      case 'cross-section-move':
        if (lastAction.previousTaskState) {
          lastAction.previousTaskState.forEach((updates, taskId) => {
            onUpdateTask(taskId, updates)
          })
        }
        if (lastAction.previousOrderUpdates) {
          onReorder?.(lastAction.previousOrderUpdates)
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

  const handleCrossSectionListDrop = useCallback(
    ({
      taskIds,
      sourceSectionId,
      sourceSectionTaskIds,
      targetSectionId,
      targetSectionTaskIds,
      overId,
      overColumnId,
      overTask,
      overTaskEdge,
      sectionDropPosition
    }: {
      taskIds: string[]
      sourceSectionId: string
      sourceSectionTaskIds?: string[]
      targetSectionId: string
      targetSectionTaskIds?: string[]
      overId: string | null
      overColumnId?: string
      overTask?: Task
      overTaskEdge: DragState['overTaskEdge']
      sectionDropPosition: DragState['sectionDropPosition']
    }): boolean => {
      const previousTaskState = new Map<string, Partial<Task>>()
      let message: { single: string; multiple: string } | null = null
      let droppedPriority: Priority | null = null

      const resolvedColumnDrop = overColumnId ? resolveColumnDrop(overColumnId, projects) : null

      taskIds.forEach((id) => {
        const task = tasks.find((entry) => entry.id === id)
        if (!task) return

        if (resolvedColumnDrop?.type === 'priority') {
          previousTaskState.set(id, { priority: task.priority })
          onUpdateTask(id, { priority: resolvedColumnDrop.priority })
          droppedPriority = resolvedColumnDrop.priority
          const priorityLabel =
            resolvedColumnDrop.priority === 'none'
              ? 'No Priority'
              : `${resolvedColumnDrop.priority.charAt(0).toUpperCase()}${resolvedColumnDrop.priority.slice(1)}`
          message = {
            single: `Priority set to ${priorityLabel}`,
            multiple: `${taskIds.length} tasks set to ${priorityLabel}`
          }
          return
        }

        if (resolvedColumnDrop?.type === 'dueDate') {
          previousTaskState.set(id, { dueDate: task.dueDate })
          onUpdateTask(id, { dueDate: resolvedColumnDrop.dueDate })
          message = {
            single: `Rescheduled to ${resolvedColumnDrop.bucketLabel}`,
            multiple: `${taskIds.length} tasks rescheduled to ${resolvedColumnDrop.bucketLabel}`
          }
          return
        }

        if (resolvedColumnDrop?.type === 'project') {
          const targetProject = projects.find(
            (project) => project.id === resolvedColumnDrop.projectId
          )
          if (!targetProject) return

          const currentProject = projects.find((project) => project.id === task.projectId)
          const currentStatus = currentProject?.statuses.find(
            (status) => status.id === task.statusId
          )
          const currentStatusType = currentStatus?.type || 'todo'
          const newStatus =
            targetProject.statuses.find((status) => status.type === currentStatusType) ??
            getDefaultTodoStatus(targetProject)

          previousTaskState.set(id, { projectId: task.projectId, statusId: task.statusId })
          onUpdateTask(id, {
            projectId: resolvedColumnDrop.projectId,
            statusId: newStatus?.id || targetProject.statuses[0]?.id
          })
          message = {
            single: `Moved to ${targetProject.name}`,
            multiple: `${taskIds.length} tasks moved to ${targetProject.name}`
          }
          return
        }

        if (resolvedColumnDrop?.type === 'canonicalStatus') {
          const taskProject = projects.find((project) => project.id === task.projectId)
          const targetStatus = taskProject?.statuses.find(
            (status) => status.type === resolvedColumnDrop.statusType
          )
          if (!targetStatus) return

          const updates: Partial<Task> = { statusId: targetStatus.id }
          if (targetStatus.type === 'done' && !task.completedAt) {
            updates.completedAt = new Date()
          } else if (targetStatus.type !== 'done' && task.completedAt) {
            updates.completedAt = null
          }

          previousTaskState.set(id, { statusId: task.statusId, completedAt: task.completedAt })
          onUpdateTask(id, updates)

          const statusLabels: Record<'todo' | 'in_progress' | 'done', string> = {
            todo: 'To Do',
            in_progress: 'In Progress',
            done: 'Done'
          }
          const label = statusLabels[resolvedColumnDrop.statusType]
          message = {
            single: `Moved to ${label}`,
            multiple: `${taskIds.length} tasks moved to ${label}`
          }
          return
        }

        if (resolvedColumnDrop?.type === 'projectStatus') {
          const targetStatus = resolvedColumnDrop.project.statuses.find(
            (status) => status.id === resolvedColumnDrop.columnId
          )
          if (!targetStatus) return

          const updates: Partial<Task> = { statusId: resolvedColumnDrop.columnId }
          if (targetStatus.type === 'done' && !task.completedAt) {
            updates.completedAt = new Date()
          } else if (targetStatus.type !== 'done' && task.completedAt) {
            updates.completedAt = null
          }

          previousTaskState.set(id, { statusId: task.statusId, completedAt: task.completedAt })
          onUpdateTask(id, updates)
          message = {
            single: `Moved to ${targetStatus.name}`,
            multiple: `${taskIds.length} tasks moved to ${targetStatus.name}`
          }
          return
        }

        if (overTask?.dueDate) {
          previousTaskState.set(id, { dueDate: task.dueDate })
          onUpdateTask(id, { dueDate: overTask.dueDate })
          const label = formatDateShort(overTask.dueDate)
          message = {
            single: `Rescheduled to ${label}`,
            multiple: `${taskIds.length} tasks rescheduled to ${label}`
          }
        }
      })

      if (previousTaskState.size === 0) {
        return false
      }

      const nextOrderUpdates = buildCrossSectionOrderUpdates({
        activeIds: taskIds,
        sourceSectionId,
        sourceSectionTaskIds,
        targetSectionId,
        targetSectionTaskIds,
        overId,
        overTaskEdge,
        sectionDropPosition
      })

      const previousOrderUpdates: Record<string, string[] | null> = {
        [sourceSectionId]: getOrder?.(sourceSectionId) ?? null,
        [targetSectionId]: getOrder?.(targetSectionId) ?? null
      }

      onReorder?.(nextOrderUpdates)

      if (droppedPriority) {
        const newDropped = new Map<string, Priority>()
        taskIds.forEach((id) => newDropped.set(id, droppedPriority!))
        setDroppedPriorities(newDropped)

        if (priorityTimerRef.current) clearTimeout(priorityTimerRef.current)
        priorityTimerRef.current = setTimeout(() => setDroppedPriorities(new Map()), 2500)
      }

      if (message) {
        recordAction(
          {
            type: 'cross-section-move',
            taskIds,
            previousTaskState,
            previousOrderUpdates
          },
          message.single
        )

        toast.success(taskIds.length === 1 ? message.single : message.multiple)
      }

      return true
    },
    [tasks, projects, onUpdateTask, onReorder, getOrder, recordAction]
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
      const dropTaskEdge = overType === 'task' ? resolveTaskEdgeFromDndEvent(event) : null

      switch (overType) {
        case 'task': {
          const overSectionId = overData?.sectionId
          const overSectionTaskIds = overData?.sectionTaskIds as string[] | undefined
          const overColumnId = overData?.columnId
          const sourceSectionId = dragState.sourceContainerId
          const sourceSectionTaskIds =
            (event.active.data.current?.sectionTaskIds as string[] | undefined) ?? taskIds

          if (
            overSectionId &&
            sourceSectionId &&
            overSectionId === sourceSectionId &&
            taskIds.length === 1
          ) {
            onReorder?.({
              [overSectionId]: buildReorderedTaskIds(
                overSectionTaskIds,
                taskIds[0],
                over.id as string,
                dropTaskEdge
              )
            })
          } else if (
            overColumnId &&
            sourceSectionId &&
            overColumnId === sourceSectionId &&
            taskIds.length === 1
          ) {
            onReorder?.({
              [overColumnId]: buildReorderedTaskIds(
                overSectionTaskIds,
                taskIds[0],
                over.id as string,
                dropTaskEdge
              )
            })
          } else if (
            sourceSectionId &&
            overSectionId &&
            sourceSectionTaskIds &&
            overSectionId !== sourceSectionId &&
            handleCrossSectionListDrop({
              taskIds,
              sourceSectionId,
              sourceSectionTaskIds,
              targetSectionId: overSectionId,
              targetSectionTaskIds: overSectionTaskIds,
              overId: over.id as string,
              overColumnId,
              overTask: overData?.task as Task | undefined,
              overTaskEdge: dropTaskEdge,
              sectionDropPosition: dragState.sectionDropPosition
            })
          ) {
            break
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
          const sourceSectionId = dragState.sourceContainerId
          const targetSectionId = (overData?.sectionId as string | undefined) ?? null
          const sourceSectionTaskIds =
            (event.active.data.current?.sectionTaskIds as string[] | undefined) ?? taskIds
          const targetSectionTaskIds = overData?.sectionTaskIds as string[] | undefined

          if (
            sourceSectionId &&
            targetSectionId &&
            sourceSectionTaskIds &&
            targetSectionId !== sourceSectionId &&
            handleCrossSectionListDrop({
              taskIds,
              sourceSectionId,
              sourceSectionTaskIds,
              targetSectionId,
              targetSectionTaskIds,
              overId: null,
              overColumnId: targetColumnId,
              overTaskEdge: dragState.overTaskEdge,
              sectionDropPosition: dragState.sectionDropPosition
            })
          ) {
            break
          }

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
      projects,
      onReorder,
      handleSectionDrop,
      handleColumnDrop,
      handlePriorityDrop,
      handleCanonicalStatusDrop,
      handleDateDrop,
      handleProjectDrop,
      handleCrossSectionListDrop,
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
