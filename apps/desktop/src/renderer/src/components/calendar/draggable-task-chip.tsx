import { useDraggable } from '@dnd-kit/core'
import { CalendarItemChip } from './calendar-item-chip'
import { cn } from '@/lib/utils'
import type { AnchorRect } from './types'
import type { CalendarProjectionItem } from '@/services/calendar-service'

interface DraggableTaskChipProps {
  item: CalendarProjectionItem
  isSelected: boolean
  onClick?: (item: CalendarProjectionItem, rect: AnchorRect) => void
  onDeleteItem?: (item: CalendarProjectionItem) => void
  onAddToProject?: (eventId: string) => void
}

/** Task chips are date-draggable via dnd-kit; every other chip renders untouched. */
export function DraggableTaskChip({
  item,
  isSelected,
  onClick,
  onDeleteItem,
  onAddToProject
}: DraggableTaskChipProps): React.JSX.Element {
  const isDraggableTask = item.sourceType === 'task' && Boolean(item.editability?.canMove)

  if (!isDraggableTask) {
    return (
      <CalendarItemChip
        item={item}
        isSelected={isSelected}
        onClick={onClick}
        onDeleteItem={onDeleteItem}
        onAddToProject={onAddToProject}
      />
    )
  }

  return (
    <DraggableTaskChipInner
      item={item}
      isSelected={isSelected}
      onClick={onClick}
      onDeleteItem={onDeleteItem}
      onAddToProject={onAddToProject}
    />
  )
}

function DraggableTaskChipInner({
  item,
  isSelected,
  onClick,
  onDeleteItem,
  onAddToProject
}: DraggableTaskChipProps): React.JSX.Element {
  // dnd-kit requires the task id here: drag-context resolves multi-select and
  // draggedTasks by matching active.id against the task list.
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: item.sourceId,
    data: {
      type: 'calendar-task',
      sourceType: 'calendar',
      taskId: item.sourceId
    }
  })

  return (
    <div
      ref={setNodeRef}
      data-testid="draggable-task-chip"
      data-task-id={item.sourceId}
      className={cn('touch-none', isDragging && 'opacity-40')}
      {...attributes}
      {...listeners}
    >
      <CalendarItemChip
        item={item}
        isSelected={isSelected}
        onClick={onClick}
        onDeleteItem={onDeleteItem}
        onAddToProject={onAddToProject}
      />
    </div>
  )
}
