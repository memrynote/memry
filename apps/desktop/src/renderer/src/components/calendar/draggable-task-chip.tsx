import { useDraggable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
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

/**
 * Task chips are date-draggable via dnd-kit; event chips are draggable only so
 * they can be dropped on a spatial canvas. Every other chip renders untouched.
 */
export function DraggableTaskChip({
  item,
  isSelected,
  onClick,
  onDeleteItem,
  onAddToProject
}: DraggableTaskChipProps): React.JSX.Element {
  const isDraggableTask = item.sourceType === 'task' && Boolean(item.editability?.canMove)

  if (isDraggableTask) {
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

  if (item.sourceType === 'event') {
    return (
      <DraggableCanvasChipInner
        item={item}
        isSelected={isSelected}
        onClick={onClick}
        onDeleteItem={onDeleteItem}
        onAddToProject={onAddToProject}
      />
    )
  }

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

/**
 * An event chip that can be dragged onto a spatial canvas to create a card.
 *
 * The drag type is deliberately NOT one of drag-context's task types, so the
 * task drag machinery (multi-select, drag overlay, reschedule-on-drop) ignores
 * it entirely; the canvas resolves it in canvas-drop-entity.ts. Since there is
 * no DragOverlay for it, the chip itself takes the drag translation so
 * something follows the cursor.
 */
function DraggableCanvasChipInner({
  item,
  isSelected,
  onClick,
  onDeleteItem,
  onAddToProject
}: DraggableTaskChipProps): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    // Namespaced: drag-context matches active.id against the task list, and a
    // bare event id could collide with a task id there. The entity id travels
    // in `data`, never parsed back out of this id.
    id: `canvas-event:${item.sourceId}`,
    data: {
      type: 'canvas-entity',
      entityType: 'calendar_event',
      entityId: item.sourceId
    }
  })

  return (
    <div
      ref={setNodeRef}
      data-testid="draggable-canvas-chip"
      data-event-id={item.sourceId}
      className={cn('touch-none', isDragging && 'relative z-50 opacity-80')}
      style={{ transform: CSS.Translate.toString(transform) }}
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
