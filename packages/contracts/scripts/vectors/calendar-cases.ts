/**
 * Fixtures for the `calendar` class (spec 007 CL011-CL013). See `calendar.ts`
 * for how the expectations are produced.
 */

type Row = Record<string, unknown>

export interface ApplyStep {
  type: 'calendar_source' | 'calendar_event' | 'calendar_external_event' | 'calendar_binding'
  payload: Row
  deleted?: boolean
}

export interface ApplyFixture {
  name: string
  id: string
  steps: ApplyStep[]
}

const source = (clock: Row, extra: Row = {}): Row => ({
  id: 'src-work',
  provider: 'google',
  kind: 'calendar',
  accountId: 'acct-1',
  remoteId: 'work@group.calendar.google.com',
  title: 'Work',
  timezone: 'Europe/Istanbul',
  color: '#9fc6e7',
  isPrimary: false,
  isSelected: true,
  isMemryManaged: false,
  syncCursor: 'CPj1',
  syncStatus: 'ok',
  lastSyncedAt: '2026-09-24T08:00:00.000Z',
  lastError: null,
  metadata: { accessRole: 'owner' },
  archivedAt: null,
  clock,
  syncedAt: null,
  createdAt: '2026-09-01T08:00:00.000Z',
  modifiedAt: '2026-09-24T08:00:00.000Z',
  ...extra
})

const external = (clock: Row, extra: Row = {}): Row => ({
  sourceId: 'src-work',
  remoteEventId: 'g-1',
  remoteEtag: '"etag-1"',
  remoteUpdatedAt: '2026-09-24T08:00:00.000Z',
  title: 'Design review',
  description: 'Agenda',
  location: 'Room 4',
  startAt: '2026-09-24T07:00:00.000Z',
  endAt: '2026-09-24T08:30:00.000Z',
  timezone: 'Europe/Istanbul',
  isAllDay: false,
  status: 'confirmed',
  recurrenceRule: null,
  attendees: [{ email: 'deniz@example.com', responseStatus: 'accepted' }],
  reminders: { useDefault: true },
  visibility: null,
  colorId: '9',
  conferenceData: { entryPoints: [{ uri: 'https://meet.google.com/abc' }] },
  rawPayload: null,
  archivedAt: null,
  clock,
  createdAt: '2026-09-24T08:00:00.000Z',
  modifiedAt: '2026-09-24T08:00:00.000Z',
  ...extra
})

const event = (clock: Row, fieldClocks: Row | null, extra: Row = {}): Row => ({
  id: 'evt-1',
  title: 'Lunch with Deniz',
  description: null,
  location: null,
  startAt: '2026-09-24T10:00:00.000Z',
  endAt: '2026-09-24T11:00:00.000Z',
  timezone: 'Europe/Istanbul',
  isAllDay: false,
  recurrenceRule: null,
  recurrenceExceptions: null,
  attendees: null,
  reminders: null,
  visibility: null,
  colorId: null,
  conferenceData: null,
  parentEventId: null,
  originalStartTime: null,
  targetCalendarId: 'work@group.calendar.google.com',
  archivedAt: null,
  clock,
  fieldClocks,
  syncedAt: null,
  createdAt: '2026-09-20T08:00:00.000Z',
  modifiedAt: '2026-09-20T08:00:00.000Z',
  ...extra
})

const binding = (clock: Row, extra: Row = {}): Row => ({
  sourceType: 'event',
  sourceId: 'evt-1',
  provider: 'google',
  remoteCalendarId: 'work@group.calendar.google.com',
  remoteEventId: 'g-1',
  ownershipMode: 'provider_managed',
  writebackMode: 'time_and_text',
  remoteVersion: '"etag-1"',
  lastLocalSnapshot: null,
  archivedAt: null,
  clock,
  createdAt: '2026-09-24T08:00:00.000Z',
  modifiedAt: '2026-09-24T08:00:00.000Z',
  ...extra
})

export const APPLY_FIXTURES: ApplyFixture[] = [
  {
    name: 'a desktop source row inserts with its values',
    id: 'src-work',
    steps: [{ type: 'calendar_source', payload: source({ desktop: 1 }) }]
  },
  {
    name: 'a source missing every optional key takes the insert defaults',
    id: 'src-bare',
    steps: [{ type: 'calendar_source', payload: { clock: { desktop: 1 } } }]
  },
  {
    name: 'a source null keeps the local value, a value replaces it',
    id: 'src-work',
    steps: [
      { type: 'calendar_source', payload: source({ desktop: 1 }) },
      {
        type: 'calendar_source',
        payload: source(
          { desktop: 2 },
          { timezone: null, color: null, metadata: null, isSelected: false, archivedAt: null }
        )
      }
    ]
  },
  {
    name: 'a stale source is skipped',
    id: 'src-work',
    steps: [
      { type: 'calendar_source', payload: source({ desktop: 3 }) },
      { type: 'calendar_source', payload: source({ desktop: 2 }, { title: 'Stale' }) }
    ]
  },
  {
    name: 'a concurrent source applies the remote under the union clock',
    id: 'src-work',
    steps: [
      { type: 'calendar_source', payload: source({ phone: 2 }) },
      { type: 'calendar_source', payload: source({ desktop: 1 }, { title: 'Renamed' }) }
    ]
  },
  {
    name: 'a source tombstone deletes it',
    id: 'src-work',
    steps: [
      { type: 'calendar_source', payload: source({ desktop: 1 }) },
      { type: 'calendar_source', payload: source({ desktop: 2 }), deleted: true }
    ]
  },
  {
    name: 'an external event with every field',
    id: 'ext-1',
    steps: [{ type: 'calendar_external_event', payload: external({ desktop: 1 }) }]
  },
  {
    name: 'external rich fields clear on null, the rest keep',
    id: 'ext-1',
    steps: [
      { type: 'calendar_external_event', payload: external({ desktop: 1 }) },
      {
        type: 'calendar_external_event',
        payload: external(
          { desktop: 2 },
          {
            attendees: null,
            conferenceData: null,
            colorId: null,
            location: null,
            description: null
          }
        )
      }
    ]
  },
  {
    name: 'an external event without its rich keys keeps them',
    id: 'ext-1',
    steps: [
      { type: 'calendar_external_event', payload: external({ desktop: 1 }) },
      {
        type: 'calendar_external_event',
        payload: (() => {
          const p = external({ desktop: 2 }, { title: 'Moved' })
          delete p.attendees
          delete p.conferenceData
          delete p.reminders
          return p
        })()
      }
    ]
  },
  {
    name: 'a binding inserts with defaults for absent keys',
    id: 'bind-1',
    steps: [
      {
        type: 'calendar_binding',
        payload: { sourceId: 'evt-1', remoteEventId: 'g-1', clock: { d: 1 } }
      }
    ]
  },
  {
    name: 'a binding update keeps on null',
    id: 'bind-1',
    steps: [
      { type: 'calendar_binding', payload: binding({ desktop: 1 }) },
      {
        type: 'calendar_binding',
        payload: binding({ desktop: 2 }, { remoteVersion: null, writebackMode: 'broad' })
      }
    ]
  },
  {
    name: 'an event insert keeps its field clocks',
    id: 'evt-1',
    steps: [{ type: 'calendar_event', payload: event({ desktop: 1 }, { title: { desktop: 1 } }) }]
  },
  {
    name: 'an event without field clocks seeds them from its clock',
    id: 'evt-1',
    steps: [{ type: 'calendar_event', payload: event({ desktop: 3 }, null) }]
  },
  {
    name: 'a dominating remote event overlays with the event presence rules',
    id: 'evt-1',
    steps: [
      {
        type: 'calendar_event',
        payload: event({ desktop: 1 }, null, { colorId: '5', location: 'Cafe' })
      },
      {
        type: 'calendar_event',
        payload: event({ desktop: 2 }, null, {
          description: null,
          location: null,
          colorId: null,
          targetCalendarId: null,
          archivedAt: '2026-09-25T08:00:00.000Z'
        })
      }
    ]
  },
  {
    name: 'a concurrent event merges field by field',
    id: 'evt-1',
    steps: [
      {
        type: 'calendar_event',
        payload: event(
          { phone: 2 },
          { title: { phone: 2 }, startAt: { phone: 1 } },
          { title: 'Phone title', location: 'Office' }
        )
      },
      {
        type: 'calendar_event',
        payload: (() => {
          const p = event(
            { phone: 1, desktop: 1 },
            { title: { phone: 1 }, startAt: { phone: 1, desktop: 1 }, location: { desktop: 1 } },
            { title: 'Desktop title', startAt: '2026-09-24T12:00:00.000Z', location: 'Cafe' }
          )
          delete p.targetCalendarId
          return p
        })()
      }
    ]
  },
  {
    name: 'a concurrent event where the remote omits a merged field keeps the local one',
    id: 'evt-1',
    steps: [
      {
        type: 'calendar_event',
        payload: event({ phone: 1 }, null, {
          description: 'Bring slides',
          targetCalendarId: 'cal-a'
        })
      },
      {
        type: 'calendar_event',
        payload: (() => {
          const p = event({ desktop: 1 }, null, { targetCalendarId: null, parentEventId: 'p-1' })
          delete p.description
          return p
        })()
      }
    ]
  },
  {
    name: 'an event tombstone deletes it',
    id: 'evt-1',
    steps: [
      { type: 'calendar_event', payload: event({ desktop: 1 }, null) },
      { type: 'calendar_event', payload: event({ desktop: 2 }, null), deleted: true }
    ]
  }
]

/** Projection fixture: every row type, one New York DST week. */
export const PROJECTION_TIMEZONE = 'America/New_York'

export const PROJECTION_ROWS: Array<{ type: string; id: string; payload: Row }> = [
  { type: 'calendar_source', id: 'src-work', payload: source({ d: 1 }) },
  {
    type: 'calendar_source',
    id: 'src-hidden',
    payload: source(
      { d: 1 },
      {
        remoteId: 'hidden@group.calendar.google.com',
        title: 'Hidden',
        isSelected: false,
        color: '#123abc'
      }
    )
  },
  {
    type: 'calendar_source',
    id: 'src-feed',
    payload: source(
      { d: 1 },
      { provider: 'ics', remoteId: 'https://example.com/feed.ics', title: 'Holidays', color: null }
    )
  },
  {
    type: 'calendar_source',
    id: 'src-acct',
    payload: source({ d: 1 }, { kind: 'account', remoteId: 'acct-1', title: 'kaan@example.com' })
  },
  {
    type: 'calendar_event',
    id: 'evtA',
    payload: event({ d: 1 }, null, {
      title: 'Standup',
      startAt: '2026-11-02T14:00:00.000Z',
      endAt: '2026-11-02T14:15:00.000Z'
    })
  },
  {
    type: 'calendar_event',
    id: 'evtb',
    payload: event({ d: 1 }, null, {
      title: 'Tomato colored',
      startAt: '2026-11-02T14:00:00.000Z',
      endAt: null,
      colorId: '11',
      targetCalendarId: null,
      description: 'x'.repeat(300)
    })
  },
  {
    type: 'calendar_event',
    id: 'evt-span',
    payload: event({ d: 1 }, null, {
      title: 'Offsite',
      startAt: '2026-10-30T04:00:00.000Z',
      endAt: '2026-11-03T05:00:00.000Z',
      isAllDay: true
    })
  },
  {
    type: 'calendar_event',
    id: 'evt-archived',
    payload: event({ d: 1 }, null, {
      title: 'Archived',
      startAt: '2026-11-02T15:00:00.000Z',
      archivedAt: '2026-10-01T00:00:00.000Z'
    })
  },
  {
    type: 'calendar_event',
    id: 'evt-outside',
    payload: event({ d: 1 }, null, {
      title: 'Next month',
      startAt: '2026-12-02T15:00:00.000Z',
      endAt: '2026-12-02T16:00:00.000Z'
    })
  },
  {
    type: 'calendar_binding',
    id: 'bind-old',
    payload: binding(
      { d: 1 },
      { sourceId: 'evtA', createdAt: '2026-09-01T00:00:00.000Z', remoteEventId: 'g-old' }
    )
  },
  {
    type: 'calendar_binding',
    id: 'bind-new',
    payload: binding(
      { d: 1 },
      {
        sourceId: 'evtA',
        createdAt: '2026-09-05T00:00:00.000Z',
        remoteEventId: 'g-new',
        provider: 'caldav'
      }
    )
  },
  {
    type: 'calendar_external_event',
    id: 'ext-work',
    payload: external(
      { d: 1 },
      { startAt: '2026-11-03T15:00:00.000Z', endAt: '2026-11-03T16:00:00.000Z', colorId: null }
    )
  },
  {
    type: 'calendar_external_event',
    id: 'ext-hidden',
    payload: external(
      { d: 1 },
      {
        sourceId: 'src-hidden',
        title: 'Hidden meeting',
        startAt: '2026-11-03T15:00:00.000Z',
        endAt: '2026-11-03T15:30:00.000Z'
      }
    )
  },
  {
    type: 'calendar_external_event',
    id: 'ext-feed',
    payload: external(
      { d: 1 },
      {
        sourceId: 'src-feed',
        title: 'Election day',
        startAt: '2026-11-03T00:00:00.000Z',
        endAt: '2026-11-04T00:00:00.000Z',
        isAllDay: true,
        timezone: null,
        colorId: null
      }
    )
  },
  {
    type: 'calendar_external_event',
    id: 'ext-orphan',
    payload: external({ d: 1 }, { sourceId: 'src-missing', title: 'Orphan' })
  },
  {
    type: 'task',
    id: 'task-timed',
    payload: {
      title: 'Send invoice',
      projectId: 'inbox',
      priority: 0,
      position: 1,
      dueDate: '2026-11-01',
      dueTime: '01:30',
      clock: { d: 1 }
    }
  },
  {
    type: 'task',
    id: 'task-allday',
    payload: {
      title: 'Pay rent',
      description: 'Online',
      projectId: 'inbox',
      priority: 0,
      position: 2,
      dueDate: '2026-11-02',
      dueTime: null,
      clock: { d: 1 }
    }
  },
  {
    type: 'task',
    id: 'task-done',
    payload: {
      title: 'Done task',
      projectId: 'inbox',
      priority: 0,
      position: 3,
      dueDate: '2026-11-02',
      completedAt: '2026-11-01T10:00:00.000Z',
      clock: { d: 1 }
    }
  },
  {
    type: 'reminder',
    id: 'rem-pending',
    payload: {
      targetType: 'task',
      targetId: 'task-allday',
      remindAt: '2026-11-02T13:30:00.000Z',
      title: '  ',
      note: null,
      highlightText: 'Pay it',
      status: 'pending',
      clock: { d: 1 }
    }
  },
  {
    type: 'reminder',
    id: 'rem-snoozed',
    payload: {
      targetType: 'journal',
      targetId: '2026-11-02',
      remindAt: '2026-11-02T09:00:00.000Z',
      title: 'Stretch',
      status: 'snoozed',
      snoozedUntil: '2026-11-02T09:45:30.000Z',
      clock: { d: 1 }
    }
  },
  {
    type: 'reminder',
    id: 'rem-dismissed',
    payload: {
      targetType: 'task',
      targetId: 'task-allday',
      remindAt: '2026-11-02T10:00:00.000Z',
      title: 'Old',
      status: 'dismissed',
      clock: { d: 1 }
    }
  },
  {
    type: 'reminder',
    id: 'rem-note-date',
    payload: {
      targetType: 'note_date',
      targetId: 'note-plan',
      remindAt: '2026-11-04T14:00:00.000Z',
      anchorId: 'blk-7',
      note: 'Ship date',
      status: 'triggered',
      clock: { d: 1 }
    }
  },
  {
    type: 'inbox',
    id: 'inbox-snoozed',
    payload: {
      title: 'Read later',
      content: 'Article',
      type: 'link',
      snoozedUntil: '2026-11-05T14:00:00.000Z',
      filedAt: null,
      archivedAt: null,
      clock: { d: 1 },
      createdAt: '2026-10-01T00:00:00.000Z'
    }
  },
  {
    type: 'inbox',
    id: 'inbox-filed',
    payload: {
      title: 'Filed',
      type: 'note',
      snoozedUntil: '2026-11-05T14:00:00.000Z',
      filedAt: '2026-11-01T00:00:00.000Z',
      clock: { d: 1 },
      createdAt: '2026-10-01T00:00:00.000Z'
    }
  },
  {
    type: 'note',
    id: 'note-plan',
    payload: {
      title: 'Launch plan',
      fileType: 'markdown',
      properties: { deadline: '2026-11-03T05:00:00.000Z', due: '2026-11-06', other: '2026-11-03' },
      clock: { d: 1 },
      createdAt: '2026-11-03T12:00:00.000Z',
      modifiedAt: '2026-11-03T12:00:00.000Z'
    }
  },
  {
    type: 'note',
    id: 'note-created',
    payload: {
      title: 'Meeting notes',
      fileType: 'markdown',
      clock: { d: 1 },
      createdAt: '2026-11-04T02:00:00.000Z',
      modifiedAt: '2026-11-04T02:00:00.000Z'
    }
  }
]

export interface ProjectionQuery {
  name: string
  startAt: string
  endAt: string
  includeUnselectedSources: boolean
  enabledPropertyNames: string[]
  showNotesByCreated: boolean
}

export const PROJECTION_QUERIES: ProjectionQuery[] = [
  {
    name: 'the DST week, selected sources, no notes',
    startAt: '2026-11-01T04:00:00.000Z',
    endAt: '2026-11-08T05:00:00.000Z',
    includeUnselectedSources: false,
    enabledPropertyNames: [],
    showNotesByCreated: false
  },
  {
    name: 'the DST week with unselected sources, date properties and created notes',
    startAt: '2026-11-01T04:00:00.000Z',
    endAt: '2026-11-08T05:00:00.000Z',
    includeUnselectedSources: true,
    enabledPropertyNames: ['deadline', 'due'],
    showNotesByCreated: true
  },
  {
    name: 'one day, Monday Nov 2',
    startAt: '2026-11-02T05:00:00.000Z',
    endAt: '2026-11-03T05:00:00.000Z',
    includeUnselectedSources: false,
    enabledPropertyNames: ['deadline'],
    showNotesByCreated: true
  },
  {
    name: 'an inverted range yields no tasks',
    startAt: '2026-11-03T05:00:00.000Z',
    endAt: '2026-11-02T05:00:00.000Z',
    includeUnselectedSources: false,
    enabledPropertyNames: [],
    showNotesByCreated: false
  }
]

export const SEARCH_QUERIES = [
  { query: 'STAND', nowMs: Date.UTC(2026, 10, 2, 12) },
  { query: 'pay', nowMs: Date.UTC(2026, 10, 2, 12) },
  { query: '   ', nowMs: Date.UTC(2026, 10, 2, 12) }
]
