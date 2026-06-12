import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import type { InboxItemListItem } from '@memry/contracts/inbox-api'

import { InboxRemindersList } from './inbox-reminders-list'
import type { ReminderPanelEntry } from '@/lib/reminder-panel'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

function snoozedItem(over: Partial<InboxItemListItem> = {}): InboxItemListItem {
  return {
    id: 'i1',
    type: 'link',
    title: 'tweet draft',
    content: null,
    createdAt: new Date('2026-06-10T00:00:00.000Z'),
    thumbnailUrl: null,
    sourceUrl: null,
    tags: [],
    isStale: false,
    processingStatus: 'complete',
    ...over
  }
}

const upcomingTask: ReminderPanelEntry = {
  kind: 'reminder-target',
  key: 'r-task',
  timeMs: Date.parse('2026-06-20T09:00:00.000Z'),
  time: new Date('2026-06-20T09:00:00.000Z'),
  nav: { targetType: 'task', targetId: 'task-1', targetTitle: 'Ship release notes' }
}

const upcomingSnoozed: ReminderPanelEntry = {
  kind: 'inbox-item',
  key: 'i-snooze',
  timeMs: Date.parse('2026-06-14T09:00:00.000Z'),
  time: new Date('2026-06-14T09:00:00.000Z'),
  item: snoozedItem()
}

const pastNote: ReminderPanelEntry = {
  kind: 'reminder-target',
  key: 'p-note',
  timeMs: Date.parse('2026-06-10T09:00:00.000Z'),
  time: new Date('2026-06-10T09:00:00.000Z'),
  nav: { targetType: 'note', targetId: 'note-1', targetTitle: 'Q3 planning' },
  inboxItemId: 'fired-1'
}

describe('InboxRemindersList', () => {
  it('renders upcoming entries with their titles', () => {
    render(
      <InboxRemindersList
        panel={{ upcoming: [upcomingTask, upcomingSnoozed], past: [] }}
        onOpen={vi.fn()}
      />
    )
    expect(screen.getByText('Ship release notes')).toBeInTheDocument()
    expect(screen.getByText('tweet draft')).toBeInTheDocument()
  })

  it('calls onOpen with the clicked entry', () => {
    const onOpen = vi.fn()
    render(<InboxRemindersList panel={{ upcoming: [upcomingTask], past: [] }} onOpen={onOpen} />)
    fireEvent.click(screen.getByText('Ship release notes'))
    expect(onOpen).toHaveBeenCalledWith(upcomingTask)
  })

  it('renders the past section when there are past entries', () => {
    render(
      <InboxRemindersList panel={{ upcoming: [upcomingTask], past: [pastNote] }} onOpen={vi.fn()} />
    )
    expect(screen.getByText('Q3 planning')).toBeInTheDocument()
    expect(screen.getByText('reminder.panelPast')).toBeInTheDocument()
  })

  it('shows the empty message and no past section when both groups are empty', () => {
    render(<InboxRemindersList panel={{ upcoming: [], past: [] }} onOpen={vi.fn()} />)
    expect(screen.getByText('reminder.panelEmpty')).toBeInTheDocument()
    expect(screen.queryByText('reminder.panelPast')).not.toBeInTheDocument()
  })
})
