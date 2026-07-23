import { describe, it, expect } from 'vitest'
import {
  CANVAS_DROP_DATA,
  entityFromDndData,
  entitiesFromDrag,
  pointerFromDragEnd
} from './canvas-drop-entity'

describe('CANVAS_DROP_DATA', () => {
  it('marks the droppable as a canvas so task drag handlers can ignore it', () => {
    expect(CANVAS_DROP_DATA).toEqual({ type: 'canvas' })
  })
})

describe('entityFromDndData', () => {
  it('maps a list/kanban task row', () => {
    expect(entityFromDndData({ type: 'task', task: { id: 't1' } }, 't1')).toEqual({
      entityType: 'task',
      entityId: 't1'
    })
  })

  it('falls back to the draggable id when the task payload has no task object', () => {
    expect(entityFromDndData({ type: 'task' }, 't2')).toEqual({
      entityType: 'task',
      entityId: 't2'
    })
  })

  it('maps a calendar task chip through taskId', () => {
    expect(entityFromDndData({ type: 'calendar-task', taskId: 't3' }, 't3')).toEqual({
      entityType: 'task',
      entityId: 't3'
    })
  })

  it('maps a subtask row', () => {
    expect(entityFromDndData({ type: 'subtask', subtask: { id: 's1' } }, 's1')).toEqual({
      entityType: 'task',
      entityId: 's1'
    })
  })

  it('maps an explicit canvas-entity payload', () => {
    expect(
      entityFromDndData(
        { type: 'canvas-entity', entityType: 'calendar_event', entityId: 'e1' },
        'canvas-event:e1'
      )
    ).toEqual({ entityType: 'calendar_event', entityId: 'e1' })
  })

  it('never trusts the draggable id for a canvas-entity payload', () => {
    // The namespaced draggable id is not the entity id — a missing entityId
    // must fail closed rather than create a card pointing at "canvas-event:e1".
    expect(
      entityFromDndData({ type: 'canvas-entity', entityType: 'note' }, 'canvas-event:e1')
    ).toBe(null)
  })

  it('rejects an unknown entityType', () => {
    expect(
      entityFromDndData({ type: 'canvas-entity', entityType: 'inbox_item', entityId: 'i1' }, 'x')
    ).toBe(null)
  })

  it('rejects drags that are not canvas-placeable', () => {
    expect(entityFromDndData({ type: 'column' }, 'c1')).toBe(null)
    expect(entityFromDndData({ type: 'tab' }, 'tab1')).toBe(null)
    expect(entityFromDndData(undefined, 'p1')).toBe(null)
    // A sidebar project reorder carries no type at all (App.tsx relies on that).
    expect(entityFromDndData({}, 'proj1')).toBe(null)
  })

  it('rejects a task drag with no usable id', () => {
    expect(entityFromDndData({ type: 'task' }, '')).toBe(null)
    expect(entityFromDndData({ type: 'calendar-task' }, '')).toBe(null)
  })
})

describe('entitiesFromDrag', () => {
  const task = (id: string): { id: string } => ({ id })

  it('expands a multi-select task drag into one ref per task', () => {
    const refs = entitiesFromDrag({ type: 'task', task: task('t1') }, 't1', [
      task('t1'),
      task('t2'),
      task('t3')
    ])
    expect(refs).toEqual([
      { entityType: 'task', entityId: 't1' },
      { entityType: 'task', entityId: 't2' },
      { entityType: 'task', entityId: 't3' }
    ])
  })

  it('ignores the selection when the dragged row is not part of it', () => {
    // Dragging an unselected row must move only that row — mirrors dnd-kit's
    // own multi-drag rule in drag-context.
    const refs = entitiesFromDrag({ type: 'task', task: task('t9') }, 't9', [
      task('t1'),
      task('t2')
    ])
    expect(refs).toEqual([{ entityType: 'task', entityId: 't9' }])
  })

  it('returns a single ref for a single-item drag', () => {
    expect(entitiesFromDrag({ type: 'task', task: task('t1') }, 't1', [task('t1')])).toEqual([
      { entityType: 'task', entityId: 't1' }
    ])
    expect(entitiesFromDrag({ type: 'task', task: task('t1') }, 't1', [])).toEqual([
      { entityType: 'task', entityId: 't1' }
    ])
  })

  it('does not multi-expand a calendar event drag', () => {
    const refs = entitiesFromDrag(
      { type: 'canvas-entity', entityType: 'calendar_event', entityId: 'e1' },
      'canvas-event:e1',
      [task('t1'), task('t2')]
    )
    expect(refs).toEqual([{ entityType: 'calendar_event', entityId: 'e1' }])
  })

  it('returns nothing for a drag the canvas cannot place', () => {
    expect(entitiesFromDrag({ type: 'column' }, 'c1', [])).toEqual([])
    expect(entitiesFromDrag(undefined, 'x', [])).toEqual([])
  })

  it('drops selected ids that no longer resolve to a task', () => {
    const refs = entitiesFromDrag({ type: 'task', task: task('t1') }, 't1', [
      task('t1'),
      { id: '' } as { id: string }
    ])
    expect(refs).toEqual([{ entityType: 'task', entityId: 't1' }])
  })
})

describe('pointerFromDragEnd', () => {
  it('adds the drag delta to the pointerdown coordinate', () => {
    const activator = { clientX: 100, clientY: 200 } as PointerEvent
    expect(pointerFromDragEnd(activator, { x: 30, y: -40 })).toEqual({
      clientX: 130,
      clientY: 160
    })
  })

  it('returns the activator coordinate when there is no delta', () => {
    const activator = { clientX: 10, clientY: 20 } as PointerEvent
    expect(pointerFromDragEnd(activator, null)).toEqual({ clientX: 10, clientY: 20 })
  })

  it('returns null for an activator with no coordinates (keyboard sensor)', () => {
    expect(pointerFromDragEnd({} as Event, { x: 1, y: 1 })).toBe(null)
    expect(pointerFromDragEnd(null, { x: 1, y: 1 })).toBe(null)
  })
})
