import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import { DraggableTaskChip } from './draggable-task-chip'
import type { CalendarProjectionItem } from '@/services/calendar-service'

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
  render(
    <DndContext>
      <DraggableTaskChip item={item} isSelected={false} />
    </DndContext>
  )

describe('DraggableTaskChip', () => {
  it('marks a movable task chip as draggable', () => {
    renderChip(makeItem())

    expect(screen.getByTestId('draggable-task-chip')).toHaveAttribute('data-task-id', 'task-1')
  })

  it('does not wrap an event chip', () => {
    renderChip(makeItem({ sourceType: 'event', sourceId: 'event-1', visualType: 'event' }))

    expect(screen.queryByTestId('draggable-task-chip')).toBeNull()
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
