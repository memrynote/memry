import { DragOverlay, type DropAnimation, defaultDropAnimationSideEffects } from "@dnd-kit/core"

import { useDragContext } from "@/contexts/drag-context"
import { MultiDragOverlay, SingleTaskPreview } from "./multi-drag-overlay"
import type { Project } from "@/data/tasks-data"

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
        opacity: "0.5",
      },
    },
  }),
  duration: 200,
  easing: "ease-out",
}

// ============================================================================
// TASK DRAG OVERLAY COMPONENT
// ============================================================================

/**
 * Unified drag overlay that switches between single and multi-drag preview
 * based on the current drag state
 */
export const TaskDragOverlay = ({
  projects,
}: TaskDragOverlayProps): React.JSX.Element => {
  const { dragState, isMultiDrag } = useDragContext()
  const { isDragging, draggedTasks } = dragState

  // Don't render if not dragging or no tasks
  if (!isDragging || draggedTasks.length === 0) {
    return <DragOverlay dropAnimation={dropAnimation}>{null}</DragOverlay>
  }

  // Check if the primary task is completed/overdue
  const primaryTask = draggedTasks[0]
  const project = projects.find((p) => p.id === primaryTask?.projectId)
  const status = project?.statuses.find((s) => s.id === primaryTask?.statusId)
  const isCompleted = status?.type === "done"

  // Check if overdue
  const isOverdue =
    !isCompleted &&
    primaryTask?.dueDate &&
    new Date(primaryTask.dueDate) < new Date(new Date().setHours(0, 0, 0, 0))

  return (
    <DragOverlay dropAnimation={dropAnimation}>
      {isMultiDrag ? (
        <MultiDragOverlay tasks={draggedTasks} />
      ) : (
        <SingleTaskPreview
          task={primaryTask}
          isCompleted={isCompleted}
          isOverdue={isOverdue}
        />
      )}
    </DragOverlay>
  )
}

export default TaskDragOverlay











