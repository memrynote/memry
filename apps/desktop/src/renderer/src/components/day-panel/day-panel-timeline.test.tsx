import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalendarProjectionItem } from '@/services/calendar-service'
import { DayPanelTimeline } from './day-panel-timeline'

const mocks = vi.hoisted(() => ({
  useCalendarRange: vi.fn(),
  moveItem: vi.fn(),
  quickCreate: vi.fn()
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('@/hooks/use-calendar-range', () => ({
  useCalendarRange: mocks.useCalendarRange
}))

vi.mock('@/hooks/use-calendar-grid-actions', () => ({
  useCalendarGridActions: () => ({ moveItem: mocks.moveItem, quickCreate: mocks.quickCreate })
}))

vi.mock('@/components/calendar/calendar-day-view', () => ({
  CalendarDayView: ({
    anchorDate,
    items,
    onSelectItem
  }: {
    anchorDate: string
    items: CalendarProjectionItem[]
    onSelectItem: (item: CalendarProjectionItem, rect: DOMRect) => void
  }) => (
    <div data-testid="grid" data-date={anchorDate}>
      {items.map((item) => (
        <button
          key={item.projectionId}
          type="button"
          onClick={() => onSelectItem(item, new DOMRect())}
        >
          {item.title}
        </button>
      ))}
    </div>
  )
}))

const item = (
  projectionId: string,
  sourceType: CalendarProjectionItem['sourceType'],
  title: string,
  isAllDay: boolean
): CalendarProjectionItem =>
  ({
    projectionId,
    sourceType,
    sourceId: projectionId.split(':')[1],
    title,
    startAt: '2026-09-21T07:00:00.000Z',
    endAt: null,
    isAllDay,
    visualType: sourceType === 'task' ? 'task' : 'event'
  }) as CalendarProjectionItem

describe('DayPanelTimeline', () => {
  beforeEach(() => {
    mocks.useCalendarRange.mockReturnValue({
      items: [
        item('task:timed', 'task', 'Write the brief', false),
        item('task:untimed', 'task', 'Call the bank', true),
        item('event:offsite', 'event', 'Team offsite', true)
      ]
    })
  })

  it("grids the day's blocks and leaves untimed tasks to the draggable task list", () => {
    render(<DayPanelTimeline date="2026-09-21" onOpenCalendar={vi.fn()} />)

    expect(screen.getByTestId('grid')).toHaveAttribute('data-date', '2026-09-21')
    expect(screen.getByRole('button', { name: 'Write the brief' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Team offsite' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Call the bank' })).toBeNull()
  })

  it('opens the Calendar on this day when a block is clicked', async () => {
    const onOpenCalendar = vi.fn()
    render(<DayPanelTimeline date="2026-09-21" onOpenCalendar={onOpenCalendar} />)

    await userEvent.click(screen.getByRole('button', { name: 'Write the brief' }))

    expect(onOpenCalendar).toHaveBeenCalledWith('2026-09-21')
  })
})
