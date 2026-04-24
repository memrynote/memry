import { useDraggable } from '@dnd-kit/core'

import { TaskRow } from './task-row'
import { useDragContext } from '@/contexts/drag-context'
import { useDroppedPriorities } from '@/contexts/dropped-priority-context'
import type { TaskRowProps } from './task-row'

interface DraggableTaskRowProps extends Omit<
  TaskRowProps,
  | 'isDragging'
  | 'isJustDropped'
  | 'dragHandleListeners'
  | 'dragHandleAttributes'
  | 'droppedPriority'
> {
  sectionId: string
}

export const DraggableTaskRow = ({
  sectionId,
  task,
  ...rest
}: DraggableTaskRowProps): React.JSX.Element => {
  const { attributes, listeners, isDragging } = useDraggable({
    id: task.id,
    data: { type: 'task', task, sectionId, sourceType: 'list' }
  })

  const { dragState } = useDragContext()
  const droppedPriorities = useDroppedPriorities()
  const isJustDropped = dragState.lastDroppedId === task.id
  const droppedPriority = droppedPriorities.get(task.id) ?? null

  return (
    <TaskRow
      task={task}
      isDragging={isDragging}
      isJustDropped={isJustDropped}
      dragHandleListeners={listeners}
      dragHandleAttributes={attributes}
      droppedPriority={droppedPriority}
      {...rest}
    />
  )
}

export default DraggableTaskRow
export type { DraggableTaskRowProps }
