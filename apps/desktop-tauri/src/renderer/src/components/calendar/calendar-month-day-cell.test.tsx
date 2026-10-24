import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { CalendarMonthDayCell } from './calendar-month-day-cell'

// `timeBehavior: 'preserve'` at the CalendarMonthDayCell call site only affects the
// dnd-kit droppable id string and the `dueTime` payload consumed by drag-context —
// neither reaches the DOM, so a flip to 'clear' (which wipes a dropped task's time)
// would render identically. Mock the hook one level up so we can assert on the real
// config the cell registers, not on rendered markup.
const droppableMocks = vi.hoisted(() => ({
  useCalendarDateDroppable: vi.fn(() => ({
    setNodeRef: vi.fn(),
    isOver: false
  }))
}))

vi.mock('./use-calendar-date-droppable', () => ({
  useCalendarDateDroppable: droppableMocks.useCalendarDateDroppable
}))

describe('CalendarMonthDayCell', () => {
  it('registers its droppable with timeBehavior "preserve" so a dropped task keeps its time', () => {
    render(
      <CalendarMonthDayCell
        day="2026-07-16"
        dayNum={16}
        inMonth
        today={false}
        weekend={false}
        highlighted={false}
        items={[]}
        maxVisibleEvents={4}
        selectedItemId={null}
      />
    )

    expect(droppableMocks.useCalendarDateDroppable).toHaveBeenCalledWith({
      date: '2026-07-16',
      timeBehavior: 'preserve'
    })
  })
})
