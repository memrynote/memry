import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import { CalendarMonthView } from './calendar-month-view'
import type { CalendarProjectionItem } from '@/services/calendar-service'

const taskItem = {
  projectionId: 'task:task-1',
  sourceType: 'task',
  sourceId: 'task-1',
  title: 'Write the spec',
  startAt: '2026-07-15T09:00:00.000Z',
  endAt: null,
  isAllDay: true,
  visualType: 'task',
  editability: { canMove: true, canResize: false, canEditText: true, canDelete: true }
} as CalendarProjectionItem

describe('CalendarMonthView drag targets', () => {
  it('renders a droppable day cell for each day and makes task chips draggable', () => {
    render(
      <DndContext>
        <CalendarMonthView anchorDate="2026-07-15" items={[taskItem]} selectedItemId={null} />
      </DndContext>
    )

    const cell = document.querySelector('[data-date="2026-07-15"]')
    expect(cell).not.toBeNull()
    expect(screen.getByTestId('draggable-task-chip')).toHaveAttribute('data-task-id', 'task-1')
  })
})
