import { useRef } from 'react'
import { DragOverlay, type DropAnimation, defaultDropAnimationSideEffects } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'

import { useDragContext } from '@/contexts/drag-context'
import { MultiDragOverlay, SingleTaskPreview } from './multi-drag-overlay'
import type { Project } from '@/data/tasks-data'

// ============================================================================
// TYPES
// ============================================================================

interface TaskDragOverlayProps {
  /** Projects for looking up task completion status */
  projects: Project[]
}

// ============================================================================
// DROP ANIMATION
// ============================================================================

const dropAnimation: DropAnimation = {
  sideEffects: defaultDropAnimationSideEffects({
    styles: {
      active: {
        opacity: '0.5'
      }
    }
  }),
  duration: 200,
  easing: 'ease-out'
}

const crossContainerDropAnimation: DropAnimation = {
  sideEffects: defaultDropAnimationSideEffects({
    styles: {
      active: {
        opacity: '0'
      }
    }
  }),
  duration: 150,
  easing: 'ease-out',
  keyframes({ transform }) {
    return [
      { opacity: 1, transform: CSS.Transform.toString(transform.initial) },
      { opacity: 0, transform: CSS.Transform.toString(transform.initial) }
    ]
  }
}

// ============================================================================
// TASK DRAG OVERLAY COMPONENT
// ============================================================================

/**
 * Unified drag overlay that switches between single and multi-drag preview
 * based on the current drag state
 */
export const TaskDragOverlay = ({ projects }: TaskDragOverlayProps): React.JSX.Element => {
  const { dragState, isMultiDrag } = useDragContext()
  const { isDragging, draggedTasks, overType, sourceContainerId, overId } = dragState

  const wasCrossContainerRef = useRef(false)

  const isCrossContainerDrop =
    (overType === 'column' && overId !== sourceContainerId) ||
    overType === 'project' ||
    overType === 'trash' ||
    overType === 'archive' ||
    overType === 'section' ||
    overType === 'date'

  // Latch cross-container state during drag; ref survives resetDragState()
  if (isDragging) {
    wasCrossContainerRef.current = isCrossContainerDrop
  }

  const effectiveDropAnimation = wasCrossContainerRef.current
    ? crossContainerDropAnimation
    : dropAnimation

  // Don't render if not dragging or no tasks
  if (!isDragging || draggedTasks.length === 0) {
    return <DragOverlay dropAnimation={effectiveDropAnimation}>{null}</DragOverlay>
  }

  // Check if the primary task is completed/overdue
  const primaryTask = draggedTasks[0]
  const project = projects.find((p) => p.id === primaryTask?.projectId)
  const status = project?.statuses.find((s) => s.id === primaryTask?.statusId)
  const isCompleted = status?.type === 'done'

  // Check if overdue
  const isOverdue = Boolean(
    !isCompleted &&
    primaryTask?.dueDate &&
    new Date(primaryTask.dueDate) < new Date(new Date().setHours(0, 0, 0, 0))
  )

  return (
    <DragOverlay dropAnimation={effectiveDropAnimation}>
      {isMultiDrag ? (
        <MultiDragOverlay tasks={draggedTasks} />
      ) : (
        <SingleTaskPreview task={primaryTask} isCompleted={isCompleted} isOverdue={isOverdue} />
      )}
    </DragOverlay>
  )
}

export default TaskDragOverlay
