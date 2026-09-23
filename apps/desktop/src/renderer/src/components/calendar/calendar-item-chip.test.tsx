import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { CalendarItemChip } from './calendar-item-chip'
import type { CalendarProjectionItem } from '@/services/calendar-service'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string) => key
  })
}))

function eventItem(overrides: Partial<CalendarProjectionItem> = {}): CalendarProjectionItem {
  return {
    projectionId: 'projection-1',
    sourceId: 'event-1',
    sourceType: 'event',
    visualType: 'event',
    title: 'Planning',
    descriptionPreview: null,
    startAt: '2026-05-14T09:00',
    endAt: '2026-05-14T10:00',
    isAllDay: false,
    color: '#64748b',
    eventType: 'memry',
    sourceCalendarId: null,
    sourceCalendarName: null,
    googleHtmlLink: null,
    sourceNoteId: null,
    taskStatus: null,
    taskPriority: null,
    taskDueDate: null,
    taskDueTime: null,
    taskProjectId: null,
    taskProjectName: null,
    reminderId: null,
    inboxItemId: null,
    editability: { canUpdate: false, canDelete: false },
    ...overrides
  } as CalendarProjectionItem
}

describe('CalendarItemChip', () => {
  it('renders a static chip when no item actions are available', () => {
    render(<CalendarItemChip item={eventItem()} />)

    expect(screen.getByText('Planning')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('fades a fired (triggered) note_date chip but keeps it visible', () => {
    render(
      <CalendarItemChip
        item={eventItem({ sourceType: 'note_date', visualType: 'note_date', isTriggered: true })}
      />
    )

    const chip = screen.getByText('Planning').closest('[data-visual-type]')
    expect(chip).toHaveAttribute('data-triggered', 'true')
    expect(chip).toHaveClass('opacity-60')
  })

  it('puts the time range under the title in the time-grid block layout', () => {
    render(<CalendarItemChip item={eventItem()} layout="block" />)

    const chip = screen.getByText('Planning').closest('[data-visual-type]')
    expect(chip).toHaveClass('flex-col')
    expect(screen.getByText('9:00 – 10:00 AM')).toBeInTheDocument()
  })

  it('keeps the start time beside the title in the inline layout', () => {
    render(<CalendarItemChip item={eventItem()} />)

    expect(screen.getByText('9:00 AM')).toBeInTheDocument()
    expect(screen.queryByText('9:00 – 10:00 AM')).not.toBeInTheDocument()
  })

  it('draws the bar appearance in ink with a colored leading bar and the range', () => {
    render(<CalendarItemChip item={eventItem()} layout="block" appearance="bar" />)

    const chip = screen.getByText('Planning').closest('[data-visual-type]')
    expect(chip).toHaveClass('border-s-[3px]')
    expect(screen.getByText('Planning')).toHaveClass('text-foreground')
    expect(screen.getByText('9:00 – 10:00 AM')).toBeInTheDocument()
  })

  it('draws the pill appearance as a dot and a title, without a time', () => {
    render(<CalendarItemChip item={eventItem({ isAllDay: true })} appearance="pill" />)

    const chip = screen.getByText('Planning').closest('[data-visual-type]')
    expect(chip).toHaveClass('h-[22px]')
    expect(screen.queryByText('time.all-day')).not.toBeInTheDocument()
  })
})
