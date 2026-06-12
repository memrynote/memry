import { describe, it, expect } from 'vitest'
import type { ReminderWithTarget } from '@memry/contracts/reminders-api'
import type { ReminderMetadata } from '@memry/contracts/inbox-api'
import type { InboxItemListItem } from '@/types'

import { buildReminderPanel } from './reminder-panel'

const NOW = Date.parse('2026-06-12T12:00:00.000Z')

function reminder(over: Partial<ReminderWithTarget> = {}): ReminderWithTarget {
  return {
    id: 'r1',
    targetType: 'task',
    targetId: 'task-1',
    remindAt: '2026-06-20T09:00:00.000Z',
    highlightText: null,
    highlightStart: null,
    highlightEnd: null,
    title: null,
    note: null,
    status: 'pending',
    triggeredAt: null,
    dismissedAt: null,
    snoozedUntil: null,
    createdAt: '2026-06-12T00:00:00.000Z',
    modifiedAt: '2026-06-12T00:00:00.000Z',
    targetTitle: 'Ship release notes',
    targetExists: true,
    projectId: 'proj-1',
    ...over
  }
}

function reminderMeta(over: Partial<ReminderMetadata> = {}): ReminderMetadata {
  return {
    reminderId: 'r-meta',
    targetType: 'note',
    targetId: 'note-1',
    targetTitle: 'Q3 planning',
    remindAt: '2026-06-10T09:00:00.000Z',
    ...over
  }
}

function inboxItem(over: Partial<InboxItemListItem> = {}): InboxItemListItem {
  return {
    id: 'i1',
    type: 'reminder',
    title: 'item',
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

describe('buildReminderPanel', () => {
  it('puts a pending reminder in upcoming with resolved nav', () => {
    const { upcoming, past } = buildReminderPanel({
      reminders: [reminder()],
      snoozedItems: [],
      reminderItems: [],
      nowMs: NOW
    })

    expect(past).toHaveLength(0)
    expect(upcoming).toHaveLength(1)
    const entry = upcoming[0]
    expect(entry.kind).toBe('reminder-target')
    if (entry.kind !== 'reminder-target') throw new Error('expected reminder-target')
    expect(entry.nav).toMatchObject({
      targetType: 'task',
      targetId: 'task-1',
      targetTitle: 'Ship release notes',
      projectId: 'proj-1'
    })
  })

  it('puts a snoozed-status reminder in upcoming', () => {
    const { upcoming } = buildReminderPanel({
      reminders: [reminder({ id: 'r2', status: 'snoozed' })],
      snoozedItems: [],
      reminderItems: [],
      nowMs: NOW
    })
    expect(upcoming).toHaveLength(1)
  })

  it('puts a future-snoozed non-reminder inbox item in upcoming as inbox-item', () => {
    const item = inboxItem({
      id: 'snz',
      type: 'link',
      title: 'tweet draft',
      snoozedUntil: new Date('2026-06-14T09:00:00.000Z')
    })
    const { upcoming } = buildReminderPanel({
      reminders: [],
      snoozedItems: [item],
      reminderItems: [],
      nowMs: NOW
    })
    expect(upcoming).toHaveLength(1)
    expect(upcoming[0].kind).toBe('inbox-item')
  })

  it('excludes inbox items snoozed in the past from upcoming', () => {
    const item = inboxItem({
      id: 'old-snz',
      type: 'link',
      snoozedUntil: new Date('2026-06-11T09:00:00.000Z')
    })
    const { upcoming } = buildReminderPanel({
      reminders: [],
      snoozedItems: [item],
      reminderItems: [],
      nowMs: NOW
    })
    expect(upcoming).toHaveLength(0)
  })

  it('puts a fired reminder inbox item in past with its inbox id', () => {
    const item = inboxItem({
      id: 'fired-1',
      type: 'reminder',
      metadata: reminderMeta({
        targetType: 'task',
        targetId: 'task-9',
        remindAt: '2026-06-10T09:00:00.000Z'
      })
    })
    const { upcoming, past } = buildReminderPanel({
      reminders: [],
      snoozedItems: [],
      reminderItems: [item],
      nowMs: NOW
    })
    expect(upcoming).toHaveLength(0)
    expect(past).toHaveLength(1)
    const entry = past[0]
    if (entry.kind !== 'reminder-target') throw new Error('expected reminder-target')
    expect(entry.inboxItemId).toBe('fired-1')
    expect(entry.nav.targetId).toBe('task-9')
  })

  it('ignores non-reminder items passed in reminderItems', () => {
    const { past } = buildReminderPanel({
      reminders: [],
      snoozedItems: [],
      reminderItems: [inboxItem({ id: 'link-1', type: 'link', metadata: undefined })],
      nowMs: NOW
    })
    expect(past).toHaveLength(0)
  })

  it('sorts upcoming ascending and past descending by time', () => {
    const { upcoming, past } = buildReminderPanel({
      reminders: [
        reminder({ id: 'late', remindAt: '2026-06-25T09:00:00.000Z' }),
        reminder({ id: 'soon', remindAt: '2026-06-13T09:00:00.000Z' })
      ],
      snoozedItems: [],
      reminderItems: [
        inboxItem({
          id: 'p-old',
          metadata: reminderMeta({ remindAt: '2026-06-01T09:00:00.000Z' })
        }),
        inboxItem({
          id: 'p-recent',
          metadata: reminderMeta({ remindAt: '2026-06-11T09:00:00.000Z' })
        })
      ],
      nowMs: NOW
    })

    expect(upcoming.map((e) => e.timeMs)).toEqual(
      [...upcoming.map((e) => e.timeMs)].sort((a, b) => a - b)
    )
    expect(upcoming[0].timeMs).toBeLessThan(upcoming[1].timeMs)
    expect(past[0].timeMs).toBeGreaterThan(past[1].timeMs)
  })

  it('dedupes a reminders-table snoozed row against a future-snoozed reminder inbox item', () => {
    const when = '2026-06-14T09:00:00.000Z'
    const { upcoming } = buildReminderPanel({
      reminders: [
        reminder({
          id: 'rdup',
          status: 'snoozed',
          targetType: 'note',
          targetId: 'note-7',
          remindAt: when
        })
      ],
      snoozedItems: [
        inboxItem({
          id: 'idup',
          type: 'reminder',
          snoozedUntil: new Date(when),
          metadata: reminderMeta({ targetType: 'note', targetId: 'note-7', remindAt: when })
        })
      ],
      reminderItems: [],
      nowMs: NOW
    })

    expect(upcoming).toHaveLength(1)
    const entry = upcoming[0]
    if (entry.kind !== 'reminder-target') throw new Error('expected reminder-target')
    expect(entry.inboxItemId).toBe('idup')
  })
})
