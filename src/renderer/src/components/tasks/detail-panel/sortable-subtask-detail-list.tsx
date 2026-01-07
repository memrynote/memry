import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { restrictToVerticalAxis, restrictToParentElement } from '@dnd-kit/modifiers'

import { SubtaskDetailItem } from './subtask-detail-item'
import type { Task } from '@/data/sample-tasks'

// ============================================================================
// TYPES
// ============================================================================

interface SortableSubtaskDetailListProps {
  parentId: string
  subtasks: Task[]
  onUpdate: (subtaskId: string, updates: Partial<Task>) => void
  onToggleComplete: (subtaskId: string) => void
  onDelete: (subtaskId: string) => void
  onReorder: (parentId: string, newOrder: string[]) => void
  onPromote: (subtaskId: string) => void
}

// ============================================================================
// HELPER: Array Move
// ============================================================================

const arrayMove = <T,>(array: T[], fromIndex: number, toIndex: number): T[] => {
  const newArray = [...array]
  const [movedItem] = newArray.splice(fromIndex, 1)
  newArray.splice(toIndex, 0, movedItem)
  return newArray
}

// ============================================================================
// SORTABLE SUBTASK DETAIL LIST COMPONENT
// ============================================================================

export const SortableSubtaskDetailList = ({
  parentId,
  subtasks,
  onUpdate,
  onToggleComplete,
  onDelete,
  onReorder,
  onPromote
}: SortableSubtaskDetailListProps): React.JSX.Element => {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8 // 8px movement required before drag starts
      }
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates
    })
  )

  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event

    if (!over || active.id === over.id) return

    const oldIndex = subtasks.findIndex((s) => s.id === active.id)
    const newIndex = subtasks.findIndex((s) => s.id === over.id)

    if (oldIndex === -1 || newIndex === -1) return

    const newOrder = arrayMove(
      subtasks.map((s) => s.id),
      oldIndex,
      newIndex
    )

    onReorder(parentId, newOrder)
  }

  const subtaskIds = subtasks.map((s) => s.id)

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
    >
      <SortableContext items={subtaskIds} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col gap-2">
          {subtasks.map((subtask) => (
            <SubtaskDetailItem
              key={subtask.id}
              subtask={subtask}
              parentId={parentId}
              onUpdate={onUpdate}
              onToggleComplete={onToggleComplete}
              onDelete={onDelete}
              onPromote={onPromote}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  )
}

export default SortableSubtaskDetailList
