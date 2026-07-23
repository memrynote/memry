/**
 * Pure mapping helpers for dropping an existing item onto a canvas via dnd-kit.
 *
 * The canvas already accepts a native HTML5 drag from the sidebar note tree
 * (see CANVAS_ITEM_DRAG_MIME in canvas-cards.ts). Task rows and calendar chips
 * cannot use that path: their dnd-kit listeners sit on the row root, so a
 * native `draggable` on the same element would put two drag systems on one
 * pointerdown. They come in through dnd-kit instead, and this module turns a
 * dnd-kit drag payload into the canvas entity refs a drop should card.
 *
 * React- and Excalidraw-free (types only), mirroring canvas-cards.ts, so the
 * mapping unit-tests without either library.
 */

import {
  CANVAS_ENTITY_TYPES,
  type CanvasEntityRef,
  type CanvasEntityType
} from '@memry/contracts/canvas-api'

/**
 * The `data` a canvas droppable registers. `use-drag-handlers` switches on
 * `over.data.current.type`, so this value must stay outside the set of task
 * drop-target types — a task dropped on a canvas must become a card without
 * also being rescheduled or moved between sections.
 */
export const CANVAS_DROP_DATA = { type: 'canvas' } as const

/** dnd-kit drag types that carry a task, across list, kanban, calendar and subtask rows. */
const TASK_DRAG_TYPES = new Set(['task', 'calendar-task', 'subtask'])

/** The drag type calendar event chips register — the canvas is their only target. */
const CANVAS_ENTITY_DRAG_TYPE = 'canvas-entity'

/** Minimal shape of anything the selection can hand back as a dragged task. */
export interface DraggedTaskLike {
  id: string
}

type DndData = Record<string, unknown> | undefined | null

function isEntityType(value: unknown): value is CanvasEntityType {
  return typeof value === 'string' && (CANVAS_ENTITY_TYPES as readonly string[]).includes(value)
}

function readId(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) {
    return value
  }
  if (value && typeof value === 'object') {
    const id = (value as { id?: unknown }).id
    if (typeof id === 'string' && id.length > 0) {
      return id
    }
  }
  return null
}

/**
 * The entity a single dnd-kit drag refers to, or null when the drag is not
 * something a canvas can place (a column, a tab, a sidebar project reorder).
 *
 * `activeId` is the draggable id and is only a fallback for task drags, where
 * it IS the task id. A canvas-entity drag namespaces its draggable id
 * (`canvas-event:<id>`), so its entity id must come from the payload alone.
 */
export function entityFromDndData(data: DndData, activeId: string): CanvasEntityRef | null {
  const type = data?.type
  if (typeof type !== 'string') {
    return null
  }

  if (TASK_DRAG_TYPES.has(type)) {
    const entityId =
      readId(data?.task) ?? readId(data?.subtask) ?? readId(data?.taskId) ?? readId(activeId)
    return entityId ? { entityType: 'task', entityId } : null
  }

  if (type === CANVAS_ENTITY_DRAG_TYPE) {
    const entityType = data?.entityType
    const entityId = readId(data?.entityId)
    if (isEntityType(entityType) && entityId) {
      return { entityType, entityId }
    }
  }

  return null
}

/**
 * Every entity a drop should card. A task drag that is part of the current
 * multi-selection expands to one ref per selected task — dragging three
 * selected rows onto a canvas places three cards. Dragging an unselected row
 * places only that row, mirroring drag-context's own multi-drag rule.
 */
export function entitiesFromDrag(
  data: DndData,
  activeId: string,
  draggedTasks: readonly DraggedTaskLike[]
): CanvasEntityRef[] {
  const single = entityFromDndData(data, activeId)
  if (!single) {
    return []
  }

  const isMultiTaskDrag =
    single.entityType === 'task' &&
    draggedTasks.length > 1 &&
    draggedTasks.some((task) => task.id === single.entityId)
  if (!isMultiTaskDrag) {
    return [single]
  }

  const refs: CanvasEntityRef[] = []
  for (const task of draggedTasks) {
    if (task.id) {
      refs.push({ entityType: 'task', entityId: task.id })
    }
  }
  return refs
}

/**
 * Where the pointer was when the drag ended. dnd-kit reports no drop
 * coordinate, only the activating pointer event and the distance dragged since
 * — their sum is the drop point. Null for a drag with no pointer at all
 * (keyboard sensor), where the caller falls back to automatic placement.
 */
export function pointerFromDragEnd(
  activatorEvent: Event | null | undefined,
  delta: { x: number; y: number } | null | undefined
): { clientX: number; clientY: number } | null {
  const source = activatorEvent as { clientX?: unknown; clientY?: unknown } | null | undefined
  if (typeof source?.clientX !== 'number' || typeof source?.clientY !== 'number') {
    return null
  }
  return {
    clientX: source.clientX + (delta?.x ?? 0),
    clientY: source.clientY + (delta?.y ?? 0)
  }
}
