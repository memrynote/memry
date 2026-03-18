import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

import { TaskRow } from './task-row'
import { useDragContext } from '@/contexts/drag-context'
import { useDroppedPriorities } from '@/contexts/dropped-priority-context'
import type { TaskRowProps } from './task-row'

interface SortableTaskRowProps extends Omit<
  TaskRowProps,
  | 'isDragging'
  | 'isJustDropped'
  | 'showDragHandle'
  | 'dragHandleListeners'
  | 'dragHandleAttributes'
  | 'insertionIndicatorPosition'
  | 'isCrossSectionTarget'
> {
  sectionId: string
  sectionTaskIds?: string[]
  columnId?: string
}

const resolveInsertionIndicatorPosition = (
  dragState: ReturnType<typeof useDragContext>['dragState'],
  taskId: string,
  sectionId: string,
  sectionTaskIds?: string[]
): 'before' | 'after' | undefined => {
  if (
    !dragState.isDragging ||
    dragState.overType !== 'task' ||
    dragState.overId !== taskId ||
    dragState.sourceContainerId !== sectionId ||
    !dragState.activeId ||
    dragState.activeId === taskId ||
    !sectionTaskIds
  ) {
    return undefined
  }

  const activeIndex = sectionTaskIds.indexOf(dragState.activeId)
  const overIndex = sectionTaskIds.indexOf(taskId)

  if (activeIndex === -1 || overIndex === -1) return undefined

  return activeIndex < overIndex ? 'after' : 'before'
}

export const SortableTaskRow = ({
  sectionId,
  sectionTaskIds,
  columnId,
  task,
  className,
  ...rest
}: SortableTaskRowProps): React.JSX.Element => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { type: 'task', task, sectionId, sectionTaskIds, columnId, sourceType: 'list' }
  })

  const { dragState } = useDragContext()
  const droppedPriorities = useDroppedPriorities()
  const isJustDropped = dragState.lastDroppedId === task.id
  const droppedPriority = droppedPriorities.get(task.id) ?? null
  const insertionIndicatorPosition = resolveInsertionIndicatorPosition(
    dragState,
    task.id,
    sectionId,
    sectionTaskIds
  )
  const isCrossSectionTarget =
    dragState.isDragging &&
    dragState.overType === 'task' &&
    dragState.overId === task.id &&
    dragState.sourceContainerId !== null &&
    dragState.sourceContainerId !== sectionId

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition || 'transform 200ms ease-out'
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-testid="sortable-task-row"
      data-task-id={task.id}
      data-section-id={sectionId}
      data-column-id={columnId ?? ''}
    >
      <TaskRow
        task={task}
        isDragging={isDragging}
        isJustDropped={isJustDropped}
        showDragHandle
        dragHandleListeners={listeners}
        dragHandleAttributes={attributes}
        droppedPriority={droppedPriority}
        insertionIndicatorPosition={insertionIndicatorPosition}
        isCrossSectionTarget={isCrossSectionTarget}
        className={className}
        {...rest}
      />
    </div>
  )
}

export default SortableTaskRow
export type { SortableTaskRowProps }
