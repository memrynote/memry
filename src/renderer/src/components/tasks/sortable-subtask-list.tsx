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

import { cn } from '@/lib/utils'
import { SortableSubtaskRow } from '@/components/tasks/sortable-subtask-row'
import { AddSubtaskInput } from '@/components/tasks/add-subtask-input'
import type { Task } from '@/data/sample-tasks'

// ============================================================================
// TYPES
// ============================================================================

interface SortableSubtaskListProps {
  parentId: string
  parentTitle: string
  subtasks: Task[]
  onReorder: (parentId: string, newOrder: string[]) => void
  onToggleComplete: (taskId: string) => void
  onAddSubtask?: (parentId: string, title: string) => void
  onClick?: (taskId: string) => void
  className?: string
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
// SORTABLE SUBTASK LIST COMPONENT
// ============================================================================

export const SortableSubtaskList = ({
  parentId,
  parentTitle,
  subtasks,
  onReorder,
  onToggleComplete,
  onAddSubtask,
  onClick,
  className
}: SortableSubtaskListProps): React.JSX.Element => {
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
    <div
      id={`subtasks-${parentId}`}
      role="group"
      aria-label={`Subtasks of ${parentTitle}`}
      className={cn('ml-[62px]', className)}
    >
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
        modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      >
        <SortableContext items={subtaskIds} strategy={verticalListSortingStrategy}>
          {subtasks.map((subtask, index) => (
            <SortableSubtaskRow
              key={subtask.id}
              subtask={subtask}
              parentId={parentId}
              isLast={index === subtasks.length - 1 && !onAddSubtask}
              onToggleComplete={onToggleComplete}
              onClick={onClick}
            />
          ))}
        </SortableContext>
      </DndContext>

      {/* Add subtask input */}
      {onAddSubtask && (
        <AddSubtaskInput parentId={parentId} onAdd={onAddSubtask} className="pl-2" />
      )}
    </div>
  )
}

export default SortableSubtaskList
