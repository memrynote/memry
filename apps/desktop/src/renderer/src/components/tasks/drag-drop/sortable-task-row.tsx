import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

import { TaskRow } from './task-row'
import { useDragContext } from '@/contexts/drag-context'
import { useDroppedPriorities } from '@/contexts/dropped-priority-context'
import type { TaskRowProps } from './task-row'

interface SortableTaskRowProps extends Omit<
  TaskRowProps,
  'isDragging' | 'isJustDropped' | 'showDragHandle' | 'dragHandleListeners' | 'dragHandleAttributes'
> {
  sectionId: string
}

export const SortableTaskRow = ({
  sectionId,
  task,
  className,
  ...rest
}: SortableTaskRowProps): React.JSX.Element => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { type: 'task', task, sectionId, sourceType: 'list' }
  })

  const { dragState } = useDragContext()
  const droppedPriorities = useDroppedPriorities()
  const isJustDropped = dragState.lastDroppedId === task.id
  const droppedPriority = droppedPriorities.get(task.id) ?? null

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition || 'transform 200ms ease-out'
  }

  return (
    <div ref={setNodeRef} style={style}>
      <TaskRow
        task={task}
        isDragging={isDragging}
        isJustDropped={isJustDropped}
        showDragHandle
        dragHandleListeners={listeners}
        dragHandleAttributes={attributes}
        droppedPriority={droppedPriority}
        className={className}
        {...rest}
      />
    </div>
  )
}

export default SortableTaskRow
export type { SortableTaskRowProps }
