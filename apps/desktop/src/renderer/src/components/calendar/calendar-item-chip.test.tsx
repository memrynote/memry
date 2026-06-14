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
})
