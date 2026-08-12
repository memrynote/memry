import { useCallback, useEffect, useRef, useState } from 'react'
import type { DragEndEvent, DragStartEvent, DragOverEvent } from '@dnd-kit/core'
import { arrayMove } from '@dnd-kit/sortable'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'

import { resolveTaskEdgeFromDndEvent, type DragState } from '@/contexts/drag-context'
import { formatDateShort, startOfDay, getDefaultTodoStatus } from '@/lib/task-utils'
import { resolveColumnDrop } from '@/lib/kanban-drop-resolver'
import { timeFromOffset } from '@/components/calendar/drop-time'
import type { Task, Priority } from '@/data/task-model'
import type { Project } from '@/data/tasks-data'
import { getI18n } from 'react-i18next'

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
  previousTimes?: Map<string, string | null>
  previousOrder?: string[]
  previousOrderUpdates?: Record<string, string[] | null>
  previousTaskState?: Map<string, Partial<Task>>
  sectionId?: string
  deletedTasks?: Task[]
}

export interface DateDropOptions {
  /** Omit to keep the task's current time; null clears it; 'HH:MM' sets it. */
  dueTime?: string | null
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

/**
 * Month cells preserve the task's time (no key), all-day cells clear it
 * (dueTime: null), timed columns derive it from where the chip landed.
 */
function resolveDropOptions(
  overData: Record<string, unknown> | undefined,
  event: DragEndEvent
): DateDropOptions | undefined {
  if (overData?.timeBehavior === 'slot') {
    const overTop = event.over?.rect.top
    const activeTop = event.active.rect.current.translated?.top
    const hourHeight = overData.hourHeight as number | undefined
    if (overTop === undefined || activeTop === undefined || !hourHeight) return undefined
    return { dueTime: timeFromOffset(activeTop - overTop, hourHeight) }
  }
  if (overData && 'dueTime' in overData) {
    return { dueTime: overData.dueTime as string | null }
  }
  return undefined
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
  const { t } = useT('tasks')
  const [undoStack, setUndoStack] = useState<UndoAction[]>([])
  const [lastActionDescription, setLastActionDescription] = useState<string | null>(null)
  const [droppedPriorities, setDroppedPriorities] = useState<Map<string, Priority>>(new Map())
  const priorityTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  // Drop the pending "dropped priority" flash timer when the board unmounts
  useEffect(
    () => () => {
      if (priorityTimerRef.current) clearTimeout(priorityTimerRef.current)
    },
    []
  )

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
            // previousTimes is only recorded for drops that changed the time.
            // Without it, restore the date alone and leave dueTime as-is.
            if (lastAction.previousTimes) {
              onUpdateTask(taskId, {
                dueDate: date,
                dueTime: lastAction.previousTimes.get(taskId) ?? null
              })
            } else {
              onUpdateTask(taskId, { dueDate: date })
            }
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
    toast.success(getI18n().getFixedT(null, 'common')('phaseI.toasts.undone'))
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
        t('toasts.drag.rescheduledTo', { target: sectionLabel })
      )

      toast.success(t('toasts.drag.rescheduled', { count: taskIds.length, target: sectionLabel }))
    },
    [tasks, onUpdateTask, recordAction, t]
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
          t('toasts.drag.movedTo', { target: targetStatus.name })
        )
      }

      toast.success(t('toasts.drag.moved', { count: taskIds.length, target: targetStatus.name }))
    },
    [tasks, onUpdateTask, recordAction, t]
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

      const label = t(`priorityLabels.${priority}`)

      recordAction(
        { type: 'change-priority', taskIds, previousPriorities },
        t('toasts.drag.prioritySetTo', { priority: label })
      )

      const newDropped = new Map<string, Priority>()
      taskIds.forEach((id) => newDropped.set(id, priority))
      setDroppedPriorities(newDropped)

      if (priorityTimerRef.current) clearTimeout(priorityTimerRef.current)
      priorityTimerRef.current = setTimeout(() => setDroppedPriorities(new Map()), 2500)

      toast.success(t('toasts.drag.prioritySet', { count: taskIds.length, priority: label }))
    },
    [tasks, onUpdateTask, recordAction, t]
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
        todo: t('statusLabels.todo'),
        in_progress: t('statusLabels.inProgress'),
        done: t('statusLabels.done')
      }
      const label = statusLabels[statusType]

      recordAction(
        { type: 'change-status', taskIds, previousStatusIds },
        t('toasts.drag.movedTo', { target: label })
      )

      toast.success(t('toasts.drag.moved', { count: taskIds.length, target: label }))
    },
    [tasks, projects, onUpdateTask, recordAction, t]
  )

  // Handle dropping on a date cell (calendar)
  const handleDateDrop = useCallback(
    (taskIds: string[], targetDate: Date, options: DateDropOptions = {}) => {
      const changesTime = 'dueTime' in options

      // Store previous dates (and times, when the drop changes them) for undo
      const previousDates = new Map<string, Date | null>()
      const previousTimes = new Map<string, string | null>()
      taskIds.forEach((id) => {
        const task = tasks.find((t) => t.id === id)
        previousDates.set(id, task?.dueDate || null)
        previousTimes.set(id, task?.dueTime ?? null)
      })

      // Update all tasks
      taskIds.forEach((id) => {
        const task = tasks.find((t) => t.id === id)
        const nextDueTime = changesTime ? (options.dueTime ?? null) : (task?.dueTime ?? null)

        let newDueDate = startOfDay(targetDate)
        if (nextDueTime) {
          const [hours, minutes] = nextDueTime.split(':').map(Number)
          newDueDate = new Date(newDueDate)
          newDueDate.setHours(hours, minutes)
        }

        onUpdateTask(
          id,
          changesTime ? { dueDate: newDueDate, dueTime: nextDueTime } : { dueDate: newDueDate }
        )
      })

      // Record for undo
      recordAction(
        {
          type: 'reschedule',
          taskIds,
          previousDates,
          ...(changesTime ? { previousTimes } : {})
        },
        t('toasts.drag.rescheduledTo', { target: formatDateShort(targetDate) })
      )

      toast.success(
        t('toasts.drag.rescheduled', {
          count: taskIds.length,
          target: formatDateShort(targetDate)
        })
      )
    },
    [tasks, onUpdateTask, recordAction, t]
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
          t('toasts.drag.movedTo', { target: targetProject.name })
        )
      }

      toast.success(t('toasts.drag.moved', { count: taskIds.length, target: targetProject.name }))
    },
    [tasks, projects, onUpdateTask, recordAction, t]
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
          const priorityLabel = t(`priorityLabels.${resolvedColumnDrop.priority}`)
          message = {
            single: t('toasts.drag.prioritySetTo', { priority: priorityLabel }),
            multiple: t('toasts.drag.prioritySet', {
              count: taskIds.length,
              priority: priorityLabel
            })
          }
          return
        }

        if (resolvedColumnDrop?.type === 'dueDate') {
          previousTaskState.set(id, { dueDate: task.dueDate })
          onUpdateTask(id, { dueDate: resolvedColumnDrop.dueDate })
          message = {
            single: t('toasts.drag.rescheduledTo', { target: resolvedColumnDrop.bucketLabel }),
            multiple: t('toasts.drag.rescheduled', {
              count: taskIds.length,
              target: resolvedColumnDrop.bucketLabel
            })
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
            single: t('toasts.drag.movedTo', { target: targetProject.name }),
            multiple: t('toasts.drag.moved', {
              count: taskIds.length,
              target: targetProject.name
            })
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
            todo: t('statusLabels.todo'),
            in_progress: t('statusLabels.inProgress'),
            done: t('statusLabels.done')
          }
          const label = statusLabels[resolvedColumnDrop.statusType]
          message = {
            single: t('toasts.drag.movedTo', { target: label }),
            multiple: t('toasts.drag.moved', { count: taskIds.length, target: label })
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
            single: t('toasts.drag.movedTo', { target: targetStatus.name }),
            multiple: t('toasts.drag.moved', {
              count: taskIds.length,
              target: targetStatus.name
            })
          }
          return
        }

        if (overTask?.dueDate) {
          previousTaskState.set(id, { dueDate: task.dueDate })
          onUpdateTask(id, { dueDate: overTask.dueDate })
          const label = formatDateShort(overTask.dueDate)
          message = {
            single: t('toasts.drag.rescheduledTo', { target: label }),
            multiple: t('toasts.drag.rescheduled', { count: taskIds.length, target: label })
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

      const resolvedMessage = message as { single: string; multiple: string } | null
      if (resolvedMessage) {
        recordAction(
          {
            type: 'cross-section-move',
            taskIds,
            previousTaskState,
            previousOrderUpdates
          },
          resolvedMessage.single
        )

        toast.success(taskIds.length === 1 ? resolvedMessage.single : resolvedMessage.multiple)
      }

      return true
    },
    [tasks, projects, onUpdateTask, onReorder, getOrder, recordAction, t]
  )

  // Handle dropping on trash (delete)
  const handleTrashDrop = useCallback(
    (taskIds: string[]) => {
      const _tasksToDelete = tasks.filter((t) => taskIds.includes(t.id))

      taskIds.forEach((id) => {
        onDeleteTask(id)
      })

      toast.success(t('toasts.drag.deleted', { count: taskIds.length }), {
        action: {
          label: getI18n().getFixedT(null, 'common')('action.undo'),
          onClick: () => {
            // Note: This is a simplified undo - actual implementation would
            // need to re-create the tasks
            toast.info(t('toasts.undoNotAvailableForDelete'))
          }
        }
      })
    },
    [tasks, onDeleteTask, t]
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
        t('toasts.drag.undoArchive', { count: taskIds.length })
      )

      toast.success(t('toasts.drag.archived', { count: taskIds.length }), {
        duration: 10000, // T052: 10-second timeout for undo per spec
        action: {
          label: getI18n().getFixedT(null, 'common')('action.undo'),
          onClick: () => void undo()
        }
      })
    },
    [onUpdateTask, recordAction, undo, t]
  )

  // Main drag end handler
  const handleDragEnd = useCallback(
    (event: DragEndEvent, dragState: DragState) => {
      const { over } = event

      if (!over) return

      const eventOverData = over.data.current
      const shouldPreferRowHoverTarget =
        dragState.sourceType === 'list' &&
        dragState.overType === 'task' &&
        dragState.overId !== null &&
        dragState.overSectionId !== null &&
        eventOverData?.type === 'column' &&
        ((eventOverData?.sectionId as string | undefined) ?? null) === dragState.overSectionId

      const overId = shouldPreferRowHoverTarget ? dragState.overId : (over.id as string)
      const overData = shouldPreferRowHoverTarget
        ? {
            ...eventOverData,
            type: 'task',
            sectionId: dragState.overSectionId,
            columnId:
              dragState.overColumnId ?? (eventOverData?.columnId as string | undefined) ?? null
          }
        : eventOverData
      const overType = overData?.type
      const taskIds = dragState.activeIds
      const dropTaskEdge =
        overType === 'task'
          ? shouldPreferRowHoverTarget
            ? dragState.overTaskEdge
            : resolveTaskEdgeFromDndEvent(event)
          : null

      switch (overType) {
        case 'task': {
          if (!overId) break

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
                overId,
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
                overId,
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
              overId,
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
          const targetColumnId = (overData?.columnId || overId) as string
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

        case 'date': {
          const targetDate = overData?.date as Date
          if (targetDate) {
            handleDateDrop(taskIds, targetDate, resolveDropOptions(overData, event))
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
  const handleDragStart = useCallback((_event: DragStartEvent, _dragState: DragState) => {
    // Can be used for analytics or additional setup
  }, [])

  // Drag over handler (for visual feedback)
  const handleDragOver = useCallback((_event: DragOverEvent, _dragState: DragState) => {
    // Can be used for additional visual feedback
  }, [])

  return {
    handleDragEnd,
    handleDragStart,
    handleDragOver,
    undo: (...args) => void undo(...args),
    canUndo: undoStack.length > 0,
    lastActionDescription,
    droppedPriorities
  }
}

export default useDragHandlers
