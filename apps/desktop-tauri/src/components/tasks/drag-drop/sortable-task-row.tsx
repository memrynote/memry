import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

import { TaskRow } from './task-row'
import { useDragContext } from '@/contexts/drag-context'
import { useDroppedPriorities } from '@/contexts/dropped-priority-context'
import {
  resolveSectionDragState,
  resolveTaskInsertionIndicatorPosition,
  shouldSuppressCrossSectionListTransform
} from './list-section-drag-state'
import type { TaskRowProps } from './task-row'

interface SortableTaskRowProps extends Omit<
  TaskRowProps,
  | 'isDragging'
  | 'isJustDropped'
  | 'dragHandleListeners'
  | 'dragHandleAttributes'
  | 'insertionIndicatorPosition'
  | 'sectionDragState'
> {
  sectionId: string
  sectionTaskIds?: string[]
  columnId?: string
}

export const SortableTaskRow = ({
  sectionId,
  sectionTaskIds,
  columnId,
  task,
  showProjectBadge = false,
  className,
  ...rest
}: SortableTaskRowProps): React.JSX.Element => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: {
      type: 'task',
      task,
      sectionId,
      sectionTaskIds,
      columnId,
      sourceType: 'list',
      overlayRowVariant: 'task',
      overlayShowProjectBadge: showProjectBadge
    }
  })

  const { dragState } = useDragContext()
  const droppedPriorities = useDroppedPriorities()
  const isJustDropped = dragState.lastDroppedId === task.id
  const droppedPriority = droppedPriorities.get(task.id) ?? null
  const insertionIndicatorPosition = resolveTaskInsertionIndicatorPosition(
    dragState,
    task.id,
    sectionId,
    sectionTaskIds
  )
  const sectionDragState = resolveSectionDragState(dragState, sectionId)
  const suppressTransform = shouldSuppressCrossSectionListTransform(dragState)

  const style: React.CSSProperties = {
    transform: suppressTransform ? undefined : CSS.Transform.toString(transform),
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
        dragHandleListeners={listeners}
        dragHandleAttributes={attributes}
        droppedPriority={droppedPriority}
        insertionIndicatorPosition={insertionIndicatorPosition}
        sectionDragState={sectionDragState}
        showProjectBadge={showProjectBadge}
        className={className}
        {...rest}
      />
    </div>
  )
}

export default SortableTaskRow
export type { SortableTaskRowProps }
