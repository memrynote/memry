import { DragOverlay, type DropAnimation, defaultDropAnimationSideEffects } from '@dnd-kit/core'

import { KanbanCardSkeleton } from './kanban-card'
import type { Task } from '@/data/sample-tasks'

// ============================================================================
// TYPES
// ============================================================================

interface KanbanDragOverlayProps {
  activeTask: Task | null
  isCompleted?: boolean
  isOverdue?: boolean
}

// ============================================================================
// DROP ANIMATION CONFIG
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

// ============================================================================
// KANBAN DRAG OVERLAY COMPONENT
// ============================================================================

export const KanbanDragOverlay = ({
  activeTask,
  isCompleted = false,
  isOverdue = false
}: KanbanDragOverlayProps): React.JSX.Element => {
  return (
    <DragOverlay dropAnimation={dropAnimation}>
      {activeTask ? (
        <KanbanCardSkeleton task={activeTask} isCompleted={isCompleted} isOverdue={isOverdue} />
      ) : null}
    </DragOverlay>
  )
}

export default KanbanDragOverlay
