import { DragOverlay, defaultDropAnimationSideEffects } from '@dnd-kit/core'

import { useDragContext } from '@/contexts/drag-context'
import type { Project } from '@/data/tasks-data'
import { KanbanCardContent } from './kanban-card'

interface KanbanDragOverlayProps {
  projects: Project[]
  allTasks: import('@/data/sample-tasks').Task[]
}

const dropAnimation = {
  duration: 200,
  easing: 'ease-out' as const,
  sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: '0.5' } } })
}

export const KanbanDragOverlay = ({
  projects,
  allTasks
}: KanbanDragOverlayProps): React.JSX.Element => {
  const { dragState } = useDragContext()
  const task = dragState.draggedTasks[0]

  if (!task || dragState.sourceType !== 'kanban') {
    return <DragOverlay dropAnimation={dropAnimation} />
  }

  const project = projects.find((p) => p.id === task.projectId)
  const isDone = task.completedAt !== null

  return (
    <DragOverlay dropAnimation={dropAnimation}>
      <div
        className="w-[256px] rotate-3 scale-105"
        style={{ filter: 'drop-shadow(0 8px 16px rgba(0,0,0,0.15))' }}
      >
        <KanbanCardContent task={task} project={project} allTasks={allTasks} isDone={isDone} />
      </div>
    </DragOverlay>
  )
}
