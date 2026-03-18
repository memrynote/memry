import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from 'react'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  closestCenter,
  pointerWithin,
  rectIntersection,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
  type CollisionDetection
} from '@dnd-kit/core'
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable'

import type { Task } from '@/data/sample-tasks'

// ============================================================================
// TYPES
// ============================================================================

export type DragSourceType = 'list' | 'kanban' | 'calendar'
export type DropTargetType =
  | 'task'
  | 'section'
  | 'column'
  | 'date'
  | 'project'
  | 'trash'
  | 'archive'
  | null

export interface DragState {
  /** Whether a drag is currently in progress */
  isDragging: boolean
  /** ID of the primary active item being dragged */
  activeId: string | null
  /** All IDs being dragged (for multi-select) */
  activeIds: string[]
  /** Source view type */
  sourceType: DragSourceType
  /** Source container ID (section, column, or date) */
  sourceContainerId: string | null
  /** Current drop target ID */
  overId: string | null
  /** Type of drop target */
  overType: DropTargetType
  /** Tasks being dragged (for overlay) */
  draggedTasks: Task[]
  /** ID of the task that was just dropped (for flash animation) */
  lastDroppedId: string | null
}

export interface DragContextValue {
  /** Current drag state */
  dragState: DragState
  /** Update drag state partially */
  setDragState: (updates: Partial<DragState>) => void
  /** Reset drag state to initial */
  resetDragState: () => void
  /** Whether multi-drag is active */
  isMultiDrag: boolean
  /** Count of items being dragged */
  dragCount: number
}

export interface DragProviderProps {
  children: ReactNode
  /** All tasks for lookup */
  tasks: Task[]
  /** Selected task IDs for multi-drag */
  selectedIds: Set<string>
  /** Callback when drag starts */
  onDragStart?: (event: DragStartEvent, state: DragState) => void
  /** Callback during drag over */
  onDragOver?: (event: DragOverEvent, state: DragState) => void
  /** Callback when drag ends */
  onDragEnd?: (event: DragEndEvent, state: DragState) => void
  /** Callback when drag is cancelled */
  onDragCancel?: () => void
}

// ============================================================================
// INITIAL STATE
// ============================================================================

const initialDragState: DragState = {
  isDragging: false,
  activeId: null,
  activeIds: [],
  sourceType: 'list',
  sourceContainerId: null,
  overId: null,
  overType: null,
  draggedTasks: [],
  lastDroppedId: null
}

// ============================================================================
// COLLISION DETECTION
// ============================================================================

/**
 * Custom collision detection that prioritizes sidebar drop zones
 * when they are being hovered, otherwise falls back to closest center
 */
const createCollisionDetection = (): CollisionDetection => {
  return (args) => {
    // First check for sidebar drop zones (project, trash, archive)
    const pointerCollisions = pointerWithin(args)
    const sidebarCollision = pointerCollisions.find((collision) => {
      const type = collision.data?.droppableContainer?.data?.current?.type
      return type === 'project' || type === 'trash' || type === 'archive'
    })

    if (sidebarCollision) {
      return [sidebarCollision]
    }

    // Check for date cells (calendar)
    const dateCollision = pointerCollisions.find((collision) => {
      const type = collision.data?.droppableContainer?.data?.current?.type
      return type === 'date'
    })

    if (dateCollision) {
      return [dateCollision]
    }

    // Compute rect intersections once — used by same-column gate, column check, and section check
    const rectCollisions = rectIntersection(args)

    // Same-column task reorder for kanban:
    // Only when the dragged card still physically overlaps its source column.
    // Without this spatial gate, closestCenter (a global algorithm) always finds
    // a source-column task even when the pointer is over a different column.
    const activeColumnId = args.active?.data?.current?.columnId
    if (activeColumnId) {
      const isOverSourceColumn = rectCollisions.some((collision) => {
        const data = collision.data?.droppableContainer?.data?.current
        return data?.type === 'column' && data?.columnId === activeColumnId
      })

      if (isOverSourceColumn) {
        const closestResults = closestCenter(args)
        const sameColumnTask = closestResults.find((collision) => {
          const data = collision.data?.droppableContainer?.data?.current
          return data?.type === 'task' && data?.columnId === activeColumnId
        })
        if (sameColumnTask) return [sameColumnTask]
      } else {
        const targetColumn = rectCollisions.find((collision) => {
          const data = collision.data?.droppableContainer?.data?.current
          return data?.type === 'column' && data?.columnId !== activeColumnId
        })
        if (targetColumn) {
          const targetColumnId = targetColumn.data?.droppableContainer?.data?.current?.columnId
          const closestResults = closestCenter(args)
          const crossColumnTask = closestResults.find((collision) => {
            const data = collision.data?.droppableContainer?.data?.current
            return data?.type === 'task' && data?.columnId === targetColumnId
          })
          if (crossColumnTask) return [crossColumnTask]
        }
      }
    }

    // Column drop zones (cross-column kanban drops, list view status groups)
    const columnCollision = rectCollisions.find((collision) => {
      const type = collision.data?.droppableContainer?.data?.current?.type
      return type === 'column'
    })

    if (columnCollision) {
      return [columnCollision]
    }

    // Check for section drop zones (date groups)
    const sectionCollision = rectCollisions.find((collision) => {
      const type = collision.data?.droppableContainer?.data?.current?.type
      return type === 'section'
    })

    if (sectionCollision) {
      return [sectionCollision]
    }

    // Fall back to closest center for task reordering
    return closestCenter(args)
  }
}

// ============================================================================
// CONTEXT
// ============================================================================

const DragContext = createContext<DragContextValue | null>(null)

// ============================================================================
// HOOK
// ============================================================================

export const useDragContext = (): DragContextValue => {
  const context = useContext(DragContext)
  if (!context) {
    throw new Error('useDragContext must be used within a DragProvider')
  }
  return context
}

// ============================================================================
// PROVIDER
// ============================================================================

export const DragProvider = ({
  children,
  tasks,
  selectedIds,
  onDragStart: onDragStartCallback,
  onDragOver: onDragOverCallback,
  onDragEnd: onDragEndCallback,
  onDragCancel: onDragCancelCallback
}: DragProviderProps): React.JSX.Element => {
  const [dragState, setDragStateInternal] = useState<DragState>(initialDragState)

  // Sensor configuration
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8 // 8px movement before drag starts
      }
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 200, // 200ms hold before drag on touch
        tolerance: 5
      }
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates
    })
  )

  // Collision detection
  const collisionDetection = useMemo(() => createCollisionDetection(), [])

  // State updater
  const setDragState = useCallback((updates: Partial<DragState>) => {
    setDragStateInternal((prev) => ({ ...prev, ...updates }))
  }, [])

  // Reset state
  const resetDragState = useCallback(() => {
    setDragStateInternal(initialDragState)
  }, [])

  // Derived values
  const isMultiDrag = dragState.activeIds.length > 1
  const dragCount = dragState.activeIds.length

  // Handle drag start
  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const { active } = event
      const draggedId = active.id as string
      const activeData = active.data.current

      // Only track task-based drags in this context
      const isTaskDrag =
        activeData?.type === 'task' ||
        activeData?.type === 'calendar-task' ||
        activeData?.type === 'subtask'
      if (!isTaskDrag) {
        return
      }

      // Determine if this is part of a multi-select
      const isPartOfSelection = selectedIds.has(draggedId)
      const shouldMultiDrag = isPartOfSelection && selectedIds.size > 1

      // Get the tasks being dragged
      const draggedTaskIds = shouldMultiDrag ? Array.from(selectedIds) : [draggedId]
      const draggedTasks = tasks.filter((t) => draggedTaskIds.includes(t.id))

      // Determine source type
      let sourceType: DragSourceType = 'list'
      if (activeData?.sourceType) {
        sourceType = activeData.sourceType
      } else if (activeData?.type === 'task' && activeData?.columnId) {
        sourceType = 'kanban'
      } else if (activeData?.type === 'calendar-task') {
        sourceType = 'calendar'
      }

      const newState: DragState = {
        isDragging: true,
        activeId: draggedId,
        activeIds: draggedTaskIds,
        sourceType,
        sourceContainerId: activeData?.sectionId || activeData?.columnId || null,
        overId: null,
        overType: null,
        draggedTasks,
        lastDroppedId: null
      }

      setDragStateInternal(newState)

      // Haptic feedback on mobile
      if ('vibrate' in navigator) {
        navigator.vibrate(50)
      }

      // Call external callback
      onDragStartCallback?.(event, newState)
    },
    [tasks, selectedIds, onDragStartCallback]
  )

  // Handle drag over
  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      // Ignore drag-over events when we're not tracking a task drag
      if (!dragState.isDragging) {
        return
      }

      const { over } = event

      if (!over) {
        setDragState({ overId: null, overType: null })
        return
      }

      const overData = over.data.current
      const overType = (overData?.type as DropTargetType) || null

      setDragState({
        overId: over.id as string,
        overType
      })

      // Call external callback
      onDragOverCallback?.(event, { ...dragState, overId: over.id as string, overType })
    },
    [dragState, setDragState, onDragOverCallback]
  )

  // Handle drag end
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const droppedId = dragState.activeId
      onDragEndCallback?.(event, dragState)
      resetDragState()

      if (droppedId && event.over) {
        setTimeout(() => {
          setDragStateInternal((prev) => ({ ...prev, lastDroppedId: droppedId }))
          setTimeout(() => setDragStateInternal((prev) => ({ ...prev, lastDroppedId: null })), 1100)
        }, 200)
      }
    },
    [dragState, resetDragState, onDragEndCallback]
  )

  // Handle drag cancel
  const handleDragCancel = useCallback(() => {
    onDragCancelCallback?.()
    resetDragState()
  }, [resetDragState, onDragCancelCallback])

  // Context value
  const contextValue = useMemo<DragContextValue>(
    () => ({
      dragState,
      setDragState,
      resetDragState,
      isMultiDrag,
      dragCount
    }),
    [dragState, setDragState, resetDragState, isMultiDrag, dragCount]
  )

  return (
    <DragContext.Provider value={contextValue}>
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        {children}
      </DndContext>
    </DragContext.Provider>
  )
}

// ============================================================================
// SCREEN READER ANNOUNCEMENTS
// ============================================================================

export const dragAnnouncements = {
  onDragStart: ({ active }: DragStartEvent): string => {
    const taskTitle = active.data.current?.task?.title || 'Task'
    return `Picked up task: ${taskTitle}. Use arrow keys to move.`
  },
  onDragOver: ({ over }: DragOverEvent): string => {
    if (!over) return ''

    const overData = over.data.current
    const type = overData?.type

    if (type === 'section') {
      return `Over section: ${overData?.label || 'Unknown'}. Release to drop.`
    }
    if (type === 'column') {
      return `Over column: ${overData?.column?.title || 'Unknown'}. Release to change status.`
    }
    if (type === 'date') {
      return `Over date: ${overData?.date?.toDateString() || 'Unknown'}. Release to reschedule.`
    }
    if (type === 'project') {
      return `Over project: ${overData?.project?.name || 'Unknown'}. Release to move.`
    }
    if (type === 'trash') {
      return 'Over trash. Release to delete.'
    }
    if (type === 'archive') {
      return 'Over archive. Release to archive.'
    }

    return ''
  },
  onDragEnd: ({ active, over }: DragEndEvent): string => {
    const taskTitle = active.data.current?.task?.title || 'Task'

    if (!over) {
      return 'Drop cancelled.'
    }

    const overData = over.data.current
    const type = overData?.type

    if (type === 'section') {
      return `Task ${taskTitle} moved to ${overData?.label || 'section'}.`
    }
    if (type === 'column') {
      return `Task ${taskTitle} status changed to ${overData?.column?.title || 'new status'}.`
    }
    if (type === 'date') {
      return `Task ${taskTitle} rescheduled.`
    }
    if (type === 'project') {
      return `Task ${taskTitle} moved to ${overData?.project?.name || 'project'}.`
    }
    if (type === 'trash') {
      return `Task ${taskTitle} deleted.`
    }
    if (type === 'archive') {
      return `Task ${taskTitle} archived.`
    }

    return `Task ${taskTitle} dropped.`
  },
  onDragCancel: (): string => 'Drag cancelled.'
}

export default DragProvider
