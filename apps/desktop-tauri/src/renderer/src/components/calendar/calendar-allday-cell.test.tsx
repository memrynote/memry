import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { CalendarAllDayCell } from './calendar-allday-cell'

// `timeBehavior: 'clear'` only affects the dueTime payload consumed by
// use-drag-handlers — it never reaches the DOM, so a flip to 'preserve' (which
// would leave a dropped task's stale time intact instead of clearing it) would
// render identically. Mock the hook one level up so we can assert on the real
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

describe('CalendarAllDayCell', () => {
  it('registers its droppable with timeBehavior "clear" so a dropped task loses its time', () => {
    render(
      <CalendarAllDayCell date="2026-07-16">
        <div data-testid="cell-body" />
      </CalendarAllDayCell>
    )

    expect(droppableMocks.useCalendarDateDroppable).toHaveBeenCalledWith({
      date: '2026-07-16',
      timeBehavior: 'clear'
    })
  })

  it('renders its children and carries the date on the DOM node', () => {
    render(
      <CalendarAllDayCell date="2026-07-16" className="test-class">
        <div data-testid="cell-body" />
      </CalendarAllDayCell>
    )

    const wrapper = document.querySelector('[data-date="2026-07-16"]')
    expect(wrapper).not.toBeNull()
    expect(wrapper).toHaveClass('test-class')
    expect(document.querySelector('[data-testid="cell-body"]')).not.toBeNull()
  })
})
