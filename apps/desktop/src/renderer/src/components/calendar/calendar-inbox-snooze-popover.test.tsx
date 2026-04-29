import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders, screen, userEvent } from '@tests/utils/render'
import { CalendarInboxSnoozePopover } from './calendar-inbox-snooze-popover'
import type { CalendarProjectionItem } from '@/services/calendar-service'

const baseItem: CalendarProjectionItem = {
  projectionId: 'inbox_snooze:item-123',
  sourceType: 'inbox_snooze',
  sourceId: 'item-123',
  title: 'Read this article',
  descriptionPreview: 'A long preview of inbox content.',
  startAt: '2026-04-30T09:00:00.000Z',
  endAt: null,
  isAllDay: false,
  timezone: 'UTC',
  visualType: 'snooze',
  editability: { canMove: false, canResize: false, canEditText: false, canDelete: true },
  source: {
    provider: null,
    calendarSourceId: null,
    title: 'Memry Inbox',
    color: null,
    kind: null,
    isMemryManaged: true
  },
  binding: null,
  snoozeOffsetMinutes: null
}

const baseAnchor = { x: 100, y: 100, width: 120, height: 24 }

describe('CalendarInboxSnoozePopover', () => {
  it('renders the inbox item title and preview', () => {
    renderWithProviders(
      <CalendarInboxSnoozePopover
        item={baseItem}
        anchorRect={baseAnchor}
        onOpenInInbox={vi.fn()}
        onUnsnooze={vi.fn()}
        onReschedule={vi.fn()}
        onDismiss={vi.fn()}
      />
    )
    expect(screen.getByText('Read this article')).toBeInTheDocument()
    expect(screen.getByText(/A long preview/)).toBeInTheDocument()
  })

  it('calls onOpenInInbox with the item id when "Open in inbox" is clicked', async () => {
    const user = userEvent.setup()
    const onOpenInInbox = vi.fn()
    renderWithProviders(
      <CalendarInboxSnoozePopover
        item={baseItem}
        anchorRect={baseAnchor}
        onOpenInInbox={onOpenInInbox}
        onUnsnooze={vi.fn()}
        onReschedule={vi.fn()}
        onDismiss={vi.fn()}
      />
    )
    await user.click(screen.getByRole('button', { name: /open in inbox/i }))
    expect(onOpenInInbox).toHaveBeenCalledWith('item-123')
  })

  it('calls onUnsnooze with the item id when "Unsnooze now" is clicked', async () => {
    const user = userEvent.setup()
    const onUnsnooze = vi.fn()
    renderWithProviders(
      <CalendarInboxSnoozePopover
        item={baseItem}
        anchorRect={baseAnchor}
        onOpenInInbox={vi.fn()}
        onUnsnooze={onUnsnooze}
        onReschedule={vi.fn()}
        onDismiss={vi.fn()}
      />
    )
    await user.click(screen.getByRole('button', { name: /unsnooze now/i }))
    expect(onUnsnooze).toHaveBeenCalledWith('item-123')
  })
})
