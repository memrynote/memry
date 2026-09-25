/**
 * Fixtures for the `inbox` class (spec 006 IB014): payload sequences in the
 * shapes desktop has pushed, and one set of rows for the list and stats
 * reads. See `inbox.ts` for how the expectations are produced.
 */

const DAY = 86_400_000
const HOUR = 3_600_000

/** 2026-09-24T12:00:00Z, a Thursday. */
export const VIEWS_NOW = Date.UTC(2026, 8, 24, 12)

const at = (ms: number): string => new Date(ms).toISOString()

/** What the current desktop pushes: its whole `inbox_items` row. */
export function currentDesktopRow(clock: Record<string, number>): Record<string, unknown> {
  return {
    id: 'inbox-1',
    type: 'link',
    title: 'How Linear builds product',
    content: 'Small teams, short cycles.',
    createdAt: '2026-04-16T08:53:20.000Z',
    modifiedAt: '2026-04-16T09:00:00.000Z',
    filedAt: null,
    filedTo: null,
    filedAction: null,
    snoozedUntil: '2026-04-17T09:00:00.000Z',
    snoozeReason: 'later',
    viewedAt: null,
    processingStatus: 'complete',
    processingError: null,
    metadata: { url: 'https://example.com/agent/1', fetchStatus: 'complete', siteName: 'Linear' },
    attachmentPath: null,
    thumbnailPath: 'attachments/inbox/inbox-1/thumbnail.jpg',
    transcription: null,
    transcriptionStatus: null,
    sourceUrl: 'https://example.com/agent/1',
    sourceTitle: null,
    captureSource: 'inline',
    archivedAt: null,
    clock,
    syncedAt: null,
    localOnly: false
  }
}

export interface ApplyStep {
  payload: Record<string, unknown>
  /** A tombstone instead of an upsert. */
  deleted?: boolean
}

export interface ApplyFixture {
  name: string
  steps: ApplyStep[]
}

export const APPLY_FIXTURES: ApplyFixture[] = [
  {
    name: 'a current desktop row inserts with every schema key',
    steps: [{ payload: currentDesktopRow({ desktop: 1 }) }]
  },
  {
    name: 'an older payload (no captureSource, sourceTitle, local columns) keeps them',
    steps: [
      { payload: currentDesktopRow({ desktop: 1 }) },
      {
        payload: {
          title: 'Renamed',
          type: 'link',
          content: 'Small teams, short cycles.',
          clock: { desktop: 2 }
        }
      }
    ]
  },
  {
    name: 'explicit nulls unsnooze, unarchive and unfile',
    steps: [
      {
        payload: {
          ...currentDesktopRow({ desktop: 1 }),
          archivedAt: '2026-04-16T10:00:00.000Z',
          filedAt: '2026-04-16T10:00:00.000Z',
          filedTo: 'Reading/How Linear builds product.md',
          filedAction: 'folder'
        }
      },
      {
        payload: {
          snoozedUntil: null,
          snoozeReason: null,
          archivedAt: null,
          filedAt: null,
          filedTo: null,
          filedAction: null,
          clock: { desktop: 2 }
        }
      }
    ]
  },
  {
    // A null title or type fails `InboxSyncPayloadSchema` (plain
    // `z.string().optional()`), so desktop skips such a payload whole; a writer
    // clears `content` instead.
    name: 'an explicit null content clears it; the title stays',
    steps: [
      { payload: currentDesktopRow({ desktop: 1 }) },
      { payload: { content: null, clock: { desktop: 2 } } }
    ]
  },
  {
    name: 'a stale remote is skipped',
    steps: [
      { payload: currentDesktopRow({ desktop: 3 }) },
      { payload: { title: 'Old', clock: { desktop: 1 } } }
    ]
  },
  {
    name: 'a bare first payload takes the insert defaults',
    steps: [{ payload: { clock: { desktop: 1 } } }]
  },
  {
    name: 'a tombstone removes the capture',
    steps: [
      { payload: currentDesktopRow({ desktop: 1 }) },
      { payload: currentDesktopRow({ desktop: 2 }), deleted: true }
    ]
  }
]

const row = (type: string, title: string, created: number): Record<string, unknown> => ({
  type,
  title,
  createdAt: at(created),
  clock: { d: 1 }
})

/** Eight captures covering every state the list and stats distinguish. */
export const VIEW_ROWS: Array<{ id: string; payload: Record<string, unknown> }> = [
  {
    id: 'a-link',
    payload: {
      ...row('link', 'Fresh link', VIEWS_NOW - HOUR),
      sourceUrl: 'https://example.com/agent/1',
      processingStatus: 'pending'
    }
  },
  {
    id: 'b-note',
    payload: {
      ...row('note', 'Aging note', VIEWS_NOW - 4 * DAY),
      content: 'Pick up the cable before Friday, then the dentist.'
    }
  },
  { id: 'c-stale', payload: row('voice', 'Stale memo', VIEWS_NOW - 9 * DAY) },
  {
    id: 'd-snoozed',
    payload: {
      ...row('image', 'Snoozed image', VIEWS_NOW - 2 * DAY),
      snoozedUntil: at(VIEWS_NOW + DAY)
    }
  },
  {
    id: 'e-archived',
    payload: {
      ...row('pdf', 'Archived pdf about ramen', VIEWS_NOW - 3 * DAY),
      archivedAt: at(VIEWS_NOW - HOUR)
    }
  },
  {
    id: 'f-filed',
    payload: {
      ...row('link', 'Filed today', VIEWS_NOW - 2 * DAY),
      filedAt: at(VIEWS_NOW - 2 * HOUR),
      filedTo: 'Reading/Filed today.md',
      filedAction: 'folder'
    }
  },
  {
    id: 'g-filed',
    payload: {
      ...row('note', 'Filed yesterday', VIEWS_NOW - 2 * DAY),
      filedAt: at(VIEWS_NOW - DAY),
      filedTo: 'Work/Plans/Filed yesterday.md',
      filedAction: 'folder'
    }
  },
  {
    id: 'h-video',
    payload: row('video', 'Clip of the demo', VIEWS_NOW - 5 * HOUR)
  }
]
