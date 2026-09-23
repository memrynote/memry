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

  it('paints a coloured event with its hue as the fill and ink for the title', () => {
    render(<CalendarItemChip item={eventItem({ color: 'green' })} />)

    const chip = screen.getByText('Planning').closest('[data-visual-type]') as HTMLElement
    expect(chip).toHaveAttribute('data-event-color', 'green')
    expect(chip.style.backgroundColor).toBe(
      'color-mix(in srgb, var(--calendar-event-green) 20%, var(--background))'
    )
    expect(chip.style.color).toBe('var(--foreground)')
  })

  it('goes solid with the on-colour ink when a coloured event is selected', () => {
    render(<CalendarItemChip item={eventItem({ color: 'red' })} isSelected />)

    const chip = screen.getByText('Planning').closest('[data-visual-type]') as HTMLElement
    expect(chip.style.backgroundColor).toBe('var(--calendar-event-red)')
    expect(chip.style.color).toBe('var(--calendar-event-on-color)')
  })

  it('keeps the event-type colour for an event with no colour', () => {
    render(<CalendarItemChip item={eventItem()} />)

    const chip = screen.getByText('Planning').closest('[data-visual-type]') as HTMLElement
    expect(chip).not.toHaveAttribute('data-event-color')
    expect(chip.style.color).toBe('rgb(146, 206, 212)')
  })
})
