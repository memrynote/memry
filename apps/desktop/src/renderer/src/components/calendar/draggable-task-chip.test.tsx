import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DraggableTaskChip } from './draggable-task-chip'
import type { CalendarProjectionItem } from '@/services/calendar-service'

// `data-task-id` and the `useDraggable({ id })` call are two separate references to
// item.sourceId in the source — asserting only the DOM attribute can't catch a
// regression where the dnd-kit id drifts to item.projectionId while the attribute
// stays put. Mock useDraggable to capture exactly what it was registered with, so
// tests can assert the real invariant: the dnd-kit id and drag payload dnd-kit
// actually sees (contexts/drag-context.tsx matches active.id against the task list).
const dndMocks = vi.hoisted(() => ({
  useDraggable: vi.fn((_config: unknown) => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    isDragging: false
  }))
}))

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => children,
  useDraggable: dndMocks.useDraggable
}))

interface DraggableConfig {
  id: string
  data: Record<string, unknown>
}

function lastDraggableConfig(): DraggableConfig {
  const call = dndMocks.useDraggable.mock.calls.at(-1)
  if (!call) throw new Error('useDraggable was not called')
  return call[0] as DraggableConfig
}

const makeItem = (overrides: Partial<CalendarProjectionItem> = {}): CalendarProjectionItem =>
  ({
    projectionId: 'task:task-1',
    sourceType: 'task',
    sourceId: 'task-1',
    title: 'Write the spec',
    startAt: '2026-07-15T00:00:00.000Z',
    endAt: null,
    isAllDay: true,
    visualType: 'task',
    editability: { canMove: true, canResize: false, canEditText: true, canDelete: true },
    ...overrides
  }) as CalendarProjectionItem

const renderChip = (item: CalendarProjectionItem) =>
  render(<DraggableTaskChip item={item} isSelected={false} />)

describe('DraggableTaskChip', () => {
  beforeEach(() => {
    dndMocks.useDraggable.mockClear()
  })

  it('marks a movable task chip as draggable', () => {
    renderChip(makeItem())

    expect(screen.getByTestId('draggable-task-chip')).toHaveAttribute('data-task-id', 'task-1')
  })

  it('registers useDraggable with the source id, not the projection id', () => {
    renderChip(makeItem())

    const config = lastDraggableConfig()
    expect(config.id).toBe('task-1')
    expect(config.id).not.toBe('task:task-1')
  })

  it('registers the exact drag payload drag-context relies on', () => {
    renderChip(makeItem())

    const config = lastDraggableConfig()
    expect(config.data).toEqual({
      type: 'calendar-task',
      sourceType: 'calendar',
      taskId: 'task-1'
    })
  })

  it('does not wrap an event chip as a task drag', () => {
    renderChip(makeItem({ sourceType: 'event', sourceId: 'event-1', visualType: 'event' }))

    // Rescheduling an event by dragging it is not a thing; the event chip is
    // draggable only so it can be dropped on a canvas.
    expect(screen.queryByTestId('draggable-task-chip')).toBeNull()
    expect(screen.getByTestId('draggable-canvas-chip')).toBeInTheDocument()
  })

  it('registers an event chip as a canvas-entity drag drag-context will ignore', () => {
    renderChip(makeItem({ sourceType: 'event', sourceId: 'event-1', visualType: 'event' }))

    const config = lastDraggableConfig()
    expect(config.data).toEqual({
      type: 'canvas-entity',
      entityType: 'calendar_event',
      entityId: 'event-1'
    })
  })

  it('namespaces the event draggable id so it cannot collide with a task id', () => {
    // drag-context resolves multi-select by matching active.id against the task
    // list; a bare event id could collide with a task id and drag the wrong rows.
    renderChip(makeItem({ sourceType: 'event', sourceId: 'event-1', visualType: 'event' }))

    const config = lastDraggableConfig()
    expect(config.id).toBe('canvas-event:event-1')
  })

  it('uses the event source id, not the projection id, for the entity', () => {
    // A recurring event projects one item per occurrence; the card must
    // reference the event, not the occurrence.
    renderChip(
      makeItem({
        projectionId: 'event:event-1:2026-07-15',
        sourceType: 'event',
        sourceId: 'event-1',
        visualType: 'event'
      })
    )

    const config = lastDraggableConfig()
    expect((config.data as unknown as { entityId: string }).entityId).toBe('event-1')
  })

  it('does not wrap a task chip that cannot move', () => {
    renderChip(
      makeItem({
        editability: { canMove: false, canResize: false, canEditText: false, canDelete: false }
      })
    )

    expect(screen.queryByTestId('draggable-task-chip')).toBeNull()
  })
})
