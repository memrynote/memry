import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
  type RefObject
} from 'react'
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

import type { SubtaskProgress } from '@/lib/subtask-utils'
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
  isDragging: boolean
  activeId: string | null
  activeIds: string[]
  sourceType: DragSourceType
  sourceContainerId: string | null
  overId: string | null
  overType: DropTargetType
  overSectionId: string | null
  overColumnId: string | null
  overTaskEdge: 'before' | 'after' | null
  sectionDropPosition: 'start' | 'end' | null
  overlayWidth: number | null
  overlayRowVariant: 'task' | 'parent' | null
  overlayShowProjectBadge: boolean
  overlayParentProgress: SubtaskProgress | null
  overlayParentExpanded: boolean
  draggedTasks: Task[]
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
  /** Live selected task IDs to use before React commits the next render */
  selectedIdsRef?: RefObject<Set<string>>
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
  overSectionId: null,
  overColumnId: null,
  overTaskEdge: null,
  sectionDropPosition: null,
  overlayWidth: null,
  overlayRowVariant: null,
  overlayShowProjectBadge: false,
  overlayParentProgress: null,
  overlayParentExpanded: false,
  draggedTasks: [],
  lastDroppedId: null
}

const getActivatorClientY = (event: Event): number | null => {
  if ('clientY' in event && typeof event.clientY === 'number') {
    return event.clientY
  }

  if ('touches' in event && event.touches.length > 0) {
    return event.touches[0]?.clientY ?? null
  }

  if ('changedTouches' in event && event.changedTouches.length > 0) {
    return event.changedTouches[0]?.clientY ?? null
  }

  return null
}

export const resolveTaskEdgeFromDndEvent = (
  event: Pick<DragOverEvent, 'over' | 'active' | 'activatorEvent' | 'delta'>
): 'before' | 'after' | null => {
  const overRect = event.over?.rect

  if (!overRect) {
    return null
  }

  const overMidY = overRect.top + overRect.height / 2
  const activatorClientY = getActivatorClientY(event.activatorEvent)

  if (activatorClientY !== null) {
    const pointerY = activatorClientY + event.delta.y
    return pointerY <= overMidY ? 'before' : 'after'
  }

  const activeRect = event.active.rect.current.translated
  if (!activeRect) {
    return null
  }

  const activeCenterY = activeRect.top + activeRect.height / 2

  return activeCenterY <= overMidY ? 'before' : 'after'
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
    const activeSourceType = args.active?.data?.current?.sourceType
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

    // Grouped list sections have both a section header drop zone and task rows.
    // Prefer the row when the pointer is actually over a task so cross-section
    // ordered drops can show row-level insertion indicators instead of sticking
    // to the header target for the whole section.
    if (activeSourceType === 'list') {
      const listTaskCollision = pointerCollisions.find((collision) => {
        const type = collision.data?.droppableContainer?.data?.current?.type
        return type === 'task'
      })

      if (listTaskCollision) {
        return [listTaskCollision]
      }
    }

    // Compute rect intersections once — used by same-column gate, column check, and section check
    const rectCollisions = rectIntersection(args)

    // Kanban cross-column vs same-column detection.
    // Use POINTER position (user intent) as primary signal, card rect as fallback.
    const activeColumnId = args.active?.data?.current?.columnId
    if (activeColumnId) {
      const pointerTargetColumn = pointerCollisions.find((collision) => {
        const data = collision.data?.droppableContainer?.data?.current
        return data?.type === 'column' && data?.columnId !== activeColumnId
      })

      if (pointerTargetColumn) {
        const targetColumnId = pointerTargetColumn.data?.droppableContainer?.data?.current?.columnId
        const closestResults = closestCenter(args)
        const crossColumnTask = closestResults.find((collision) => {
          const data = collision.data?.droppableContainer?.data?.current
          return data?.type === 'task' && data?.columnId === targetColumnId
        })
        return crossColumnTask ? [crossColumnTask] : [pointerTargetColumn]
      }

      const pointerOverSource = pointerCollisions.some((collision) => {
        const data = collision.data?.droppableContainer?.data?.current
        return data?.type === 'column' && data?.columnId === activeColumnId
      })

      if (pointerOverSource) {
        const closestResults = closestCenter(args)
        const sameColumnTask = closestResults.find((collision) => {
          const data = collision.data?.droppableContainer?.data?.current
          return data?.type === 'task' && data?.columnId === activeColumnId
        })
        if (sameColumnTask) return [sameColumnTask]
      }

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
        return [targetColumn]
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
  selectedIdsRef,
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
      const overlayWidth = active.rect.current.initial?.width
        ? Math.round(active.rect.current.initial.width)
        : null

      // Only track task-based drags in this context
      const isTaskDrag =
        activeData?.type === 'task' ||
        activeData?.type === 'calendar-task' ||
        activeData?.type === 'subtask'
      if (!isTaskDrag) {
        return
      }

      // Determine if this is part of a multi-select
      const activeSelectedIds = selectedIdsRef?.current ?? selectedIds
      const isPartOfSelection = activeSelectedIds.has(draggedId)
      const shouldMultiDrag = isPartOfSelection && activeSelectedIds.size > 1

      // Get the tasks being dragged
      const draggedTaskIds = shouldMultiDrag ? Array.from(activeSelectedIds) : [draggedId]
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
        overSectionId: null,
        overColumnId: null,
        overTaskEdge: null,
        sectionDropPosition: null,
        overlayWidth,
        overlayRowVariant:
          activeData?.overlayRowVariant === 'parent' || activeData?.overlayRowVariant === 'task'
            ? activeData.overlayRowVariant
            : null,
        overlayShowProjectBadge: Boolean(activeData?.overlayShowProjectBadge),
        overlayParentProgress:
          (activeData?.overlayParentProgress as SubtaskProgress | undefined) ?? null,
        overlayParentExpanded: Boolean(activeData?.overlayParentExpanded),
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
    [tasks, selectedIds, selectedIdsRef, onDragStartCallback]
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
        setDragState({
          overId: null,
          overType: null,
          overSectionId: null,
          overColumnId: null,
          overTaskEdge: null,
          sectionDropPosition: null
        })
        return
      }

      const overData = over.data.current
      const overType = (overData?.type as DropTargetType) || null
      const overSectionId = (overData?.sectionId as string | undefined) ?? null
      const overColumnId = (overData?.columnId as string | undefined) ?? null
      const overTaskEdge = overType === 'task' ? resolveTaskEdgeFromDndEvent(event) : null
      const sectionDropPosition =
        overType === 'column'
          ? ((overData?.sectionDropPosition as 'start' | 'end' | undefined) ?? 'start')
          : null

      setDragState({
        overId: over.id as string,
        overType,
        overSectionId,
        overColumnId,
        overTaskEdge,
        sectionDropPosition
      })

      // Call external callback
      onDragOverCallback?.(event, {
        ...dragState,
        overId: over.id as string,
        overType,
        overSectionId,
        overColumnId,
        overTaskEdge,
        sectionDropPosition
      })
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
