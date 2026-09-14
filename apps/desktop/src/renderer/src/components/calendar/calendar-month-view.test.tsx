import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import { CalendarMonthView } from './calendar-month-view'
import type { CalendarProjectionItem } from '@/services/calendar-service'

// SAFETY: fixture carries every field the month grid reads (id, dates, visual
// type, editability); the cast only skips unused projection metadata.
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

// Local instants: the projection stores local midnights, and the month grid
// reads them back as local days.
function localIso(year: number, month: number, day: number): string {
  return new Date(year, month - 1, day, 0, 0, 0, 0).toISOString()
}

// SAFETY: same fixture shape as taskItem, with a multi-day all-day range.
const multiDayItem = {
  projectionId: 'event:trip',
  sourceType: 'event',
  sourceId: 'trip',
  title: 'Offsite',
  startAt: localIso(2026, 7, 14),
  endAt: localIso(2026, 7, 17),
  isAllDay: true,
  visualType: 'event',
  editability: { canMove: true, canResize: true, canEditText: true, canDelete: true }
} as CalendarProjectionItem

describe('CalendarMonthView multi-day spans', () => {
  it('renders one bar covering every day of the span instead of a chip on the start day', () => {
    render(
      <DndContext>
        <CalendarMonthView anchorDate="2026-07-15" items={[multiDayItem]} selectedItemId={null} />
      </DndContext>
    )

    const bars = screen.getAllByTestId('calendar-span-bar')
    expect(bars).toHaveLength(1)
    // July 14-16 inclusive: the exclusive July 17 midnight end is not a 4th day.
    expect(bars[0]).toHaveAttribute('data-span-columns', '3')
    expect(screen.queryByTestId('draggable-task-chip')).toBeNull()
  })

  it('splits a span that crosses a week boundary into one bar per week row', () => {
    // SAFETY: spread of the checked multiDayItem fixture, dates only.
    const crossingWeeks = {
      ...multiDayItem,
      startAt: localIso(2026, 7, 17),
      endAt: localIso(2026, 7, 21)
    } as CalendarProjectionItem

    render(
      <DndContext>
        <CalendarMonthView anchorDate="2026-07-15" items={[crossingWeeks]} selectedItemId={null} />
      </DndContext>
    )

    const bars = screen.getAllByTestId('calendar-span-bar')
    expect(bars).toHaveLength(2)
    const columns = bars.map((bar) => bar.getAttribute('data-span-columns'))
    expect(columns.map(Number).reduce((a, b) => a + b, 0)).toBe(4)
  })
})

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
