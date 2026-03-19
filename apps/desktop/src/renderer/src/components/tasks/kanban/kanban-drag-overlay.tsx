import { useRef } from 'react'
import { DragOverlay, type DropAnimation, defaultDropAnimationSideEffects } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'

import { useDragContext } from '@/contexts/drag-context'
import type { Project } from '@/data/tasks-data'
import { KanbanCardContent } from './kanban-card'

interface KanbanDragOverlayProps {
  projects: Project[]
  allTasks: import('@/data/sample-tasks').Task[]
}

const dropAnimation: DropAnimation = {
  duration: 200,
  easing: 'ease-out',
  sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: '0.5' } } })
}

const crossContainerDropAnimation: DropAnimation = {
  sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: '0' } } }),
  duration: 150,
  easing: 'ease-out',
  keyframes({ transform }) {
    return [
      { opacity: 1, transform: CSS.Transform.toString(transform.initial) },
      { opacity: 0, transform: CSS.Transform.toString(transform.initial) }
    ]
  }
}

export const KanbanDragOverlay = ({
  projects,
  allTasks
}: KanbanDragOverlayProps): React.JSX.Element => {
  const { dragState } = useDragContext()
  const { isDragging, overType, overId, sourceContainerId } = dragState
  const task = dragState.draggedTasks[0]

  const wasCrossContainerRef = useRef(false)

  const overTaskColumn =
    overType === 'task' && overId ? allTasks.find((t) => t.id === overId)?.statusId : null
  const isCrossContainerDrop =
    (overType === 'column' && overId !== sourceContainerId) ||
    (overType === 'task' && overTaskColumn != null && overTaskColumn !== sourceContainerId)

  if (isDragging) {
    wasCrossContainerRef.current = isCrossContainerDrop
  }

  const effectiveDropAnimation = wasCrossContainerRef.current
    ? crossContainerDropAnimation
    : dropAnimation

  if (!task || dragState.sourceType !== 'kanban') {
    return <DragOverlay dropAnimation={effectiveDropAnimation} />
  }

  const project = projects.find((p) => p.id === task.projectId)
  const isDone = task.completedAt !== null

  return (
    <DragOverlay dropAnimation={effectiveDropAnimation}>
      <div
        className="w-[256px] rotate-3 scale-105"
        style={{ filter: 'drop-shadow(0 8px 16px rgba(0,0,0,0.15))' }}
      >
        <KanbanCardContent
          task={task}
          project={project}
          allTasks={allTasks}
          isDone={isDone}
          showProjectBadge={false}
        />
      </div>
    </DragOverlay>
  )
}
