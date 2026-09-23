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
    color: null,
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

  it('tints a coloured event with its colour and keeps ink for the title', () => {
    render(<CalendarItemChip item={eventItem({ color: 'sage', displayColor: '#33b679' })} />)

    const chip = screen.getByText('Planning').closest('[data-visual-type]') as HTMLElement
    expect(chip).toHaveAttribute('data-event-color', '#33b679')
    expect(chip.style.backgroundColor).toBe('color-mix(in srgb, #33b679 20%, var(--background))')
    expect(chip.style.color).toBe('var(--foreground)')
  })

  it('goes solid with readable ink when a coloured event is selected', () => {
    render(
      <CalendarItemChip item={eventItem({ color: 'tomato', displayColor: '#d50000' })} isSelected />
    )

    const chip = screen.getByText('Planning').closest('[data-visual-type]') as HTMLElement
    expect(chip.style.backgroundColor).toBe('rgb(213, 0, 0)')
    expect(chip.style.color).toBe('rgb(255, 255, 255)')
  })

  it('paints an external event with the colour of its Google calendar', () => {
    render(
      <CalendarItemChip
        item={eventItem({ visualType: 'external_event', color: null, displayColor: '#4285f4' })}
      />
    )

    const chip = screen.getByText('Planning').closest('[data-visual-type]') as HTMLElement
    expect(chip).toHaveAttribute('data-event-color', '#4285f4')
    expect(chip.style.backgroundColor).toBe('color-mix(in srgb, #4285f4 20%, var(--background))')
  })

  it('keeps the event-type colour for an event with no colour', () => {
    render(<CalendarItemChip item={eventItem()} />)

    const chip = screen.getByText('Planning').closest('[data-visual-type]') as HTMLElement
    expect(chip).not.toHaveAttribute('data-event-color')
    expect(chip.style.color).toBe('rgb(146, 206, 212)')
  })
})
