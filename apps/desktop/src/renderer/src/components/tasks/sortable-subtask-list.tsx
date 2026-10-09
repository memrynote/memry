import { useState } from 'react'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type Modifier
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { restrictToParentElement } from '@dnd-kit/modifiers'

import { cn } from '@/lib/utils'
import { calculateProgress, getSubtasks } from '@/lib/subtask-utils'
import {
  SortableSubtaskRow,
  type SubtaskDropProjection
} from '@/components/tasks/sortable-subtask-row'
import { SubtaskDraftRow } from '@/components/tasks/subtask-tree/subtask-draft-row'
import { useSubtaskTree } from '@/components/tasks/subtask-tree/subtask-tree-context'
import { useTaskExpansion } from '@/components/tasks/subtask-tree/task-expansion-context'
import type { Task } from '@/data/task-model'
import type { Status } from '@/data/tasks-data'

// ============================================================================
// TYPES
// ============================================================================

interface SortableSubtaskListProps {
  parent: Task
  subtasks: Task[]
  /** Where deeper subtasks are looked up; the list the host renders from. */
  allTasks: Task[]
  statuses: Status[]
  /** 1 for the first level under a top-level task. */
  depth?: number
  onReorder: (parentId: string, newOrder: string[]) => void
  onToggleComplete: (taskId: string) => void
  onClick?: (taskId: string) => void
  className?: string
}

/** One indent step. A drag this far sideways nests or un-nests the row. */
const INDENT_PX = 20
/** Deeper than this, rows stop moving right so titles keep their width. */
const MAX_VISUAL_DEPTH = 5

/** Lets the dragged row follow the pointer a step sideways, no further. */
const sidewaysStep: Modifier = ({ transform }) => ({
  ...transform,
  x: Math.max(-INDENT_PX * 1.5, Math.min(INDENT_PX * 1.5, transform.x))
})
const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 })

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
  parent,
  subtasks,
  allTasks,
  statuses,
  depth = 1,
  onReorder,
  onToggleComplete,
  onClick,
  className
}: SortableSubtaskListProps): React.JSX.Element => {
  const tree = useSubtaskTree()
  const expansion = useTaskExpansion()
  const expandedIds = expansion?.expandedIds
  const onToggleExpand = expansion?.toggle
  const [projection, setProjection] = useState<{ id: string; value: SubtaskDropProjection }>()
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

  const grandparent = parent.parentId
    ? (allTasks.find((t) => t.id === parent.parentId) ?? null)
    : null

  /**
   * A drop a step to the right nests the row under the one that ends up above
   * it; a step to the left moves it out next to its parent.
   */
  const project = (
    activeId: string,
    overId: string | null,
    deltaX: number
  ): SubtaskDropProjection => {
    if (!tree) return null
    if (deltaX <= -INDENT_PX) {
      return tree.canMoveUnder(activeId, parent.parentId) ? { kind: 'out' } : null
    }
    if (deltaX < INDENT_PX) return null
    const order = subtasks.map((s) => s.id)
    const from = order.indexOf(activeId)
    const to = overId ? order.indexOf(overId) : from
    const moved = arrayMove(order, from, to === -1 ? from : to)
    const aboveId = moved[moved.indexOf(activeId) - 1]
    const above = aboveId ? subtasks.find((s) => s.id === aboveId) : undefined
    if (!above || !tree.canMoveUnder(activeId, above.id)) return null
    return { kind: 'nest', parentTitle: above.title }
  }

  const handleDragMove = (event: DragMoveEvent): void => {
    const id = String(event.active.id)
    const value = project(id, event.over ? String(event.over.id) : null, event.delta.x)
    setProjection((current) =>
      current?.id === id && JSON.stringify(current.value) === JSON.stringify(value)
        ? current
        : { id, value }
    )
  }

  const handleDragEnd = (event: DragEndEvent): void => {
    setProjection(undefined)
    const { active, over } = event
    const activeId = String(active.id)
    const overId = over ? String(over.id) : null

    const outcome = project(activeId, overId, event.delta.x)
    if (outcome && tree) {
      if (outcome.kind === 'out') {
        tree.moveUnder(activeId, parent.parentId)
        return
      }
      const order = subtasks.map((s) => s.id)
      const moved = arrayMove(order, order.indexOf(activeId), overId ? order.indexOf(overId) : 0)
      const aboveId = moved[moved.indexOf(activeId) - 1]
      if (aboveId) {
        expansion?.expand(aboveId)
        tree.moveUnder(activeId, aboveId)
      }
      return
    }

    if (!overId || activeId === overId) return

    const oldIndex = subtasks.findIndex((s) => s.id === activeId)
    const newIndex = subtasks.findIndex((s) => s.id === overId)

    if (oldIndex === -1 || newIndex === -1) return

    const newOrder = arrayMove(
      subtasks.map((s) => s.id),
      oldIndex,
      newIndex
    )

    onReorder(parent.id, newOrder)
  }

  const subtaskIds = subtasks.map((s) => s.id)
  const showDraft = tree?.draftParentId === parent.id

  return (
    <div
      id={`subtasks-${parent.id}`}
      role="group"
      aria-label={`Subtasks of ${parent.title}`}
      className={cn(className)}
    >
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragMove={handleDragMove}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setProjection(undefined)}
        // The row spans its list, so keeping it inside its parent would pin the
        // sideways step at zero; `sidewaysStep` bounds it instead.
        modifiers={tree ? [sidewaysStep] : [verticalOnly, restrictToParentElement]}
      >
        <SortableContext items={subtaskIds} strategy={verticalListSortingStrategy}>
          {subtasks.map((subtask, index) => {
            const children = getSubtasks(subtask.id, allTasks)
            const isExpanded = expandedIds?.has(subtask.id) ?? false
            const showChildren =
              (isExpanded && children.length > 0) || tree?.draftParentId === subtask.id
            return (
              <div key={subtask.id}>
                <SortableSubtaskRow
                  subtask={subtask}
                  statuses={statuses}
                  parentId={parent.id}
                  depth={depth}
                  progress={calculateProgress(children)}
                  isExpanded={isExpanded}
                  onToggleExpand={onToggleExpand}
                  projection={projection?.id === subtask.id ? projection.value : null}
                  rowAbove={index > 0 ? subtasks[index - 1] : undefined}
                  onToggleComplete={onToggleComplete}
                  onClick={onClick}
                />
                {showChildren && (
                  <SortableSubtaskList
                    parent={subtask}
                    subtasks={isExpanded ? children : []}
                    allTasks={allTasks}
                    statuses={statuses}
                    depth={depth + 1}
                    onReorder={onReorder}
                    onToggleComplete={onToggleComplete}
                    onClick={onClick}
                    className={nestedListClass(depth)}
                  />
                )}
              </div>
            )
          })}
        </SortableContext>
      </DndContext>
      {showDraft && (
        <SubtaskDraftRow parent={parent} siblings={subtasks} grandparent={grandparent} />
      )}
    </div>
  )
}

/**
 * The guide line of a nested level sits under its parent's status icon. A
 * top-level parent (`parentDepth` 0) has its icon after the row padding, the
 * chevron, and the selection column when the list has one. Past
 * `MAX_VISUAL_DEPTH` levels stop indenting, so a deep title keeps its width.
 */
export const nestedListClass = (parentDepth: number, hasSelectColumn = false): string =>
  parentDepth >= MAX_VISUAL_DEPTH
    ? ''
    : parentDepth > 0
      ? 'ms-[31px] border-s border-border'
      : hasSelectColumn
        ? 'ms-[70px] border-s border-border'
        : 'ms-[44px] border-s border-border'

export default SortableSubtaskList
