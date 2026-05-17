import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CalendarYearView } from './calendar-year-view'
import type { CalendarProjectionItem } from '@/services/calendar-service'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string) => key,
    i18n: { language: 'en-US' }
  })
}))

vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => ({
    settings: { clockFormat: '12h' }
  })
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverAnchor: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="year-popover">{children}</div>
  )
}))

const eventItem: CalendarProjectionItem = {
  projectionId: 'event:event-1',
  sourceType: 'event',
  sourceId: 'event-1',
  title: 'Planning block',
  descriptionPreview: null,
  startAt: '2026-05-10T09:00:00.000Z',
  endAt: '2026-05-10T10:00:00.000Z',
  isAllDay: false,
  timezone: 'UTC',
  visualType: 'event',
  editability: { canMove: true, canResize: true, canEditText: true, canDelete: true },
  source: {
    provider: null,
    calendarSourceId: null,
    title: 'memrynote',
    color: '#2563eb',
    kind: null,
    isMemryManaged: true
  },
  binding: null
}

const allDayItem: CalendarProjectionItem = {
  ...eventItem,
  projectionId: 'task:task-1',
  sourceType: 'task',
  sourceId: 'task-1',
  title: 'All day task',
  isAllDay: true,
  visualType: 'task',
  source: { ...eventItem.source, color: null }
}

const dayButton = (name: RegExp) => screen.getAllByRole('button', { name })[0]

describe('CalendarYearView', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('opens day popovers, selects items, and routes double-clicks to month view', () => {
    const onSelectItem = vi.fn()
    const onViewChange = vi.fn()
    const onAnchorChange = vi.fn()

    render(
      <CalendarYearView
        anchorDate="2026-05-10"
        items={[eventItem, allDayItem]}
        onSelectItem={onSelectItem}
        onViewChange={onViewChange}
        onAnchorChange={onAnchorChange}
      />
    )

    fireEvent.click(dayButton(/Sunday, May 10/i))
    act(() => vi.advanceTimersByTime(250))
    expect(screen.getByText('Planning block')).toBeInTheDocument()
    expect(screen.getByText('All day task')).toBeInTheDocument()
    expect(screen.getByText('time.all-day-lower')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Planning block'))
    expect(onSelectItem).toHaveBeenCalledWith(
      eventItem,
      expect.objectContaining({ x: expect.any(Number), width: expect.any(Number) })
    )

    fireEvent.doubleClick(dayButton(/Monday, May 11/i))
    expect(onAnchorChange).toHaveBeenCalledWith('2026-05-11')
    expect(onViewChange).toHaveBeenCalledWith('month')
  })

  it('shows an empty day popover and cancels a pending single click on double-click', () => {
    const onViewChange = vi.fn()
    render(
      <CalendarYearView
        anchorDate="2026-05-10"
        items={[]}
        onViewChange={onViewChange}
        onAnchorChange={vi.fn()}
      />
    )

    const emptyDay = dayButton(/Tuesday, May 12/i)
    fireEvent.click(emptyDay)
    act(() => vi.advanceTimersByTime(250))
    expect(screen.getByText('empty.no-events')).toBeInTheDocument()

    fireEvent.click(dayButton(/Wednesday, May 13/i))
    fireEvent.doubleClick(dayButton(/Wednesday, May 13/i))
    act(() => vi.advanceTimersByTime(250))
    expect(onViewChange).toHaveBeenCalledWith('month')
  })
})
