/**
 * Sync Payload Contract Tests
 *
 * Per-item-type encrypted payload shapes consumed by sync item handlers.
 * Covers optional-field tolerance, nullable-string handling, and Phase 8
 * field-clock regression (fieldClocks on tasks/projects).
 */

import { describe, it, expect } from 'vitest'

import {
  CalendarBindingSyncPayloadSchema,
  CalendarEventSyncPayloadSchema,
  CalendarExternalEventSyncPayloadSchema,
  CalendarSourceSyncPayloadSchema,
  FilterSyncPayloadSchema,
  FolderConfigSyncPayloadSchema,
  InboxSyncPayloadSchema,
  JournalSyncPayloadSchema,
  NoteSyncPayloadSchema,
  ProjectSyncPayloadSchema,
  StatusSyncSchema,
  TagDefinitionSyncPayloadSchema,
  TaskSyncPayloadSchema
} from './sync-payloads'

describe('TaskSyncPayloadSchema', () => {
  it('accepts empty payload (all optional)', () => {
    expect(TaskSyncPayloadSchema.safeParse({}).success).toBe(true)
  })

  it('accepts full payload with clock + fieldClocks (Phase 8 regression)', () => {
    const result = TaskSyncPayloadSchema.safeParse({
      title: 'Write tests',
      description: 'Cover all schemas',
      projectId: 'proj-1',
      statusId: 'status-1',
      parentId: null,
      priority: 2,
      position: 0,
      dueDate: '2026-04-20',
      dueTime: '14:30',
      startDate: '2026-04-18',
      repeatConfig: { frequency: 'weekly' },
      repeatFrom: 'due',
      sourceNoteId: null,
      completedAt: null,
      archivedAt: null,
      tags: ['work'],
      linkedNoteIds: ['note-1'],
      clock: { 'device-a': 3 },
      fieldClocks: {
        title: { 'device-a': 3 },
        description: { 'device-a': 2, 'device-b': 1 }
      },
      createdAt: '2026-04-01T00:00:00Z',
      modifiedAt: '2026-04-16T00:00:00Z'
    })
    expect(result.success).toBe(true)
  })

  it('accepts null description (nullable)', () => {
    expect(TaskSyncPayloadSchema.safeParse({ description: null }).success).toBe(true)
  })

  it('rejects non-string title', () => {
    const result = TaskSyncPayloadSchema.safeParse({ title: 42 })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('title')
    }
  })

  it('rejects fieldClocks with non-clock value', () => {
    const result = TaskSyncPayloadSchema.safeParse({
      fieldClocks: { title: 'not-a-clock' }
    })
    expect(result.success).toBe(false)
  })

  it('rejects clock with negative tick', () => {
    const result = TaskSyncPayloadSchema.safeParse({
      clock: { 'device-a': -1 }
    })
    expect(result.success).toBe(false)
  })

  it('rejects tags containing non-string', () => {
    const result = TaskSyncPayloadSchema.safeParse({ tags: ['ok', 1] })
    expect(result.success).toBe(false)
  })
})

describe('InboxSyncPayloadSchema', () => {
  it('accepts empty payload', () => {
    expect(InboxSyncPayloadSchema.safeParse({}).success).toBe(true)
  })

  it('accepts full inbox entry', () => {
    const result = InboxSyncPayloadSchema.safeParse({
      title: 'Read later',
      content: null,
      type: 'url',
      metadata: { favicon: 'x' },
      filedAt: null,
      filedTo: null,
      filedAction: null,
      snoozedUntil: '2026-04-20T00:00:00Z',
      snoozeReason: 'later',
      archivedAt: null,
      sourceUrl: 'https://example.com',
      sourceTitle: 'Example',
      captureSource: 'web-clipper',
      clock: { 'device-a': 1 },
      createdAt: '2026-04-16T00:00:00Z',
      modifiedAt: '2026-04-16T00:00:00Z'
    })
    expect(result.success).toBe(true)
  })

  it('rejects non-string content (not nullable unknown)', () => {
    const result = InboxSyncPayloadSchema.safeParse({ content: 123 })
    expect(result.success).toBe(false)
  })
})

describe('FilterSyncPayloadSchema', () => {
  it('accepts unknown config (unstructured)', () => {
    const result = FilterSyncPayloadSchema.safeParse({
      name: 'Today',
      config: { any: 'shape' },
      position: 0
    })
    expect(result.success).toBe(true)
  })

  it('rejects non-number position', () => {
    const result = FilterSyncPayloadSchema.safeParse({ position: '0' })
    expect(result.success).toBe(false)
  })
})

describe('StatusSyncSchema', () => {
  const base = { id: 's1', name: 'Todo', color: '#abc', position: 0 }

  it('accepts minimal required fields', () => {
    expect(StatusSyncSchema.safeParse(base).success).toBe(true)
  })

  it('accepts optional flags', () => {
    const result = StatusSyncSchema.safeParse({
      ...base,
      isDefault: true,
      isDone: false,
      createdAt: '2026-04-16T00:00:00Z'
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing name', () => {
    const { name: _name, ...rest } = base
    expect(StatusSyncSchema.safeParse(rest).success).toBe(false)
  })
})

describe('ProjectSyncPayloadSchema', () => {
  it('accepts empty payload', () => {
    expect(ProjectSyncPayloadSchema.safeParse({}).success).toBe(true)
  })

  it('accepts project with fieldClocks (Phase 8 regression)', () => {
    const result = ProjectSyncPayloadSchema.safeParse({
      name: 'Side project',
      description: null,
      color: '#ff5733',
      icon: null,
      position: 1,
      isInbox: false,
      archivedAt: null,
      clock: { 'device-a': 1 },
      fieldClocks: { name: { 'device-a': 1 } },
      statuses: [{ id: 's1', name: 'Todo', color: '#abc', position: 0 }]
    })
    expect(result.success).toBe(true)
  })

  it('rejects statuses containing invalid entry', () => {
    const result = ProjectSyncPayloadSchema.safeParse({
      statuses: [{ id: 's1', name: 'Todo', color: '#abc' }]
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path[0]).toBe('statuses')
    }
  })
})

describe('NoteSyncPayloadSchema', () => {
  it('accepts empty payload', () => {
    expect(NoteSyncPayloadSchema.safeParse({}).success).toBe(true)
  })

  it('accepts properties as Record<string, unknown>', () => {
    const result = NoteSyncPayloadSchema.safeParse({
      title: 'N',
      properties: { rating: 5, tags: ['a'] }
    })
    expect(result.success).toBe(true)
  })

  it('accepts null properties', () => {
    const result = NoteSyncPayloadSchema.safeParse({ properties: null })
    expect(result.success).toBe(true)
  })

  it('accepts all fileType enum values', () => {
    const values = ['markdown', 'pdf', 'image', 'audio', 'video'] as const
    for (const fileType of values) {
      expect(NoteSyncPayloadSchema.safeParse({ fileType }).success).toBe(true)
    }
  })

  it('rejects invalid fileType', () => {
    const result = NoteSyncPayloadSchema.safeParse({ fileType: 'doc' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('fileType')
    }
  })

  it('rejects non-string tag entry', () => {
    const result = NoteSyncPayloadSchema.safeParse({ tags: ['ok', 1] })
    expect(result.success).toBe(false)
  })
})

describe('JournalSyncPayloadSchema', () => {
  it('accepts minimal journal with date', () => {
    expect(JournalSyncPayloadSchema.safeParse({ date: '2026-04-16' }).success).toBe(true)
  })

  it('accepts full journal entry', () => {
    const result = JournalSyncPayloadSchema.safeParse({
      date: '2026-04-16',
      content: 'Today...',
      tags: ['personal'],
      properties: { mood: 'calm' },
      clock: { 'device-a': 1 },
      createdAt: '2026-04-16T00:00:00Z',
      modifiedAt: '2026-04-16T01:00:00Z'
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing date', () => {
    const result = JournalSyncPayloadSchema.safeParse({ content: 'Today...' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('date')
    }
  })
})

describe('TagDefinitionSyncPayloadSchema', () => {
  it('accepts minimal required fields', () => {
    expect(
      TagDefinitionSyncPayloadSchema.safeParse({ name: 'work', color: '#abc' }).success
    ).toBe(true)
  })

  it('rejects missing color', () => {
    expect(TagDefinitionSyncPayloadSchema.safeParse({ name: 'work' }).success).toBe(false)
  })
})

describe('FolderConfigSyncPayloadSchema', () => {
  it('accepts null icon (required field, nullable)', () => {
    expect(FolderConfigSyncPayloadSchema.safeParse({ icon: null }).success).toBe(true)
  })

  it('accepts string icon', () => {
    expect(FolderConfigSyncPayloadSchema.safeParse({ icon: 'folder' }).success).toBe(true)
  })

  it('rejects missing icon field', () => {
    const result = FolderConfigSyncPayloadSchema.safeParse({})
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('icon')
    }
  })
})

describe('CalendarEventSyncPayloadSchema', () => {
  it('accepts minimal empty payload', () => {
    expect(CalendarEventSyncPayloadSchema.safeParse({}).success).toBe(true)
  })

  it('accepts recurrenceRule as record and exceptions as ISO datetime strings (M5)', () => {
    const result = CalendarEventSyncPayloadSchema.safeParse({
      title: 'Standup',
      startAt: '2026-04-16T09:00:00Z',
      endAt: '2026-04-16T09:15:00Z',
      timezone: 'UTC',
      isAllDay: false,
      recurrenceRule: { freq: 'DAILY' },
      recurrenceExceptions: ['2026-04-18T09:00:00.000Z']
    })
    expect(result.success).toBe(true)
  })

  it('rejects non-record recurrenceRule', () => {
    const result = CalendarEventSyncPayloadSchema.safeParse({
      recurrenceRule: 'DAILY'
    })
    expect(result.success).toBe(false)
  })
})

describe('CalendarSourceSyncPayloadSchema', () => {
  it('accepts all kind enum values', () => {
    expect(
      CalendarSourceSyncPayloadSchema.safeParse({ kind: 'account' }).success
    ).toBe(true)
    expect(
      CalendarSourceSyncPayloadSchema.safeParse({ kind: 'calendar' }).success
    ).toBe(true)
  })

  it('accepts all syncStatus enum values', () => {
    const values = ['idle', 'ok', 'error', 'pending'] as const
    for (const syncStatus of values) {
      expect(CalendarSourceSyncPayloadSchema.safeParse({ syncStatus }).success).toBe(true)
    }
  })

  it('rejects invalid kind', () => {
    const result = CalendarSourceSyncPayloadSchema.safeParse({ kind: 'group' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('kind')
    }
  })

  it('rejects invalid syncStatus', () => {
    const result = CalendarSourceSyncPayloadSchema.safeParse({ syncStatus: 'running' })
    expect(result.success).toBe(false)
  })
})

describe('CalendarBindingSyncPayloadSchema', () => {
  it('accepts sourceType enum values', () => {
    const values = ['event', 'task', 'reminder', 'inbox_snooze'] as const
    for (const sourceType of values) {
      expect(CalendarBindingSyncPayloadSchema.safeParse({ sourceType }).success).toBe(true)
    }
  })

  it('accepts ownershipMode values', () => {
    const values = ['memry_managed', 'provider_managed'] as const
    for (const ownershipMode of values) {
      expect(CalendarBindingSyncPayloadSchema.safeParse({ ownershipMode }).success).toBe(true)
    }
  })

  it('accepts writebackMode values', () => {
    const values = ['schedule_only', 'time_and_text', 'broad'] as const
    for (const writebackMode of values) {
      expect(CalendarBindingSyncPayloadSchema.safeParse({ writebackMode }).success).toBe(true)
    }
  })

  it('rejects invalid sourceType', () => {
    const result = CalendarBindingSyncPayloadSchema.safeParse({ sourceType: 'unknown' })
    expect(result.success).toBe(false)
  })

  it('accepts lastLocalSnapshot as record or null', () => {
    expect(
      CalendarBindingSyncPayloadSchema.safeParse({ lastLocalSnapshot: { a: 1 } }).success
    ).toBe(true)
    expect(
      CalendarBindingSyncPayloadSchema.safeParse({ lastLocalSnapshot: null }).success
    ).toBe(true)
  })
})

describe('CalendarExternalEventSyncPayloadSchema', () => {
  it('accepts minimal empty payload', () => {
    expect(CalendarExternalEventSyncPayloadSchema.safeParse({}).success).toBe(true)
  })

  it('accepts all status enum values', () => {
    const values = ['confirmed', 'tentative', 'cancelled'] as const
    for (const status of values) {
      expect(CalendarExternalEventSyncPayloadSchema.safeParse({ status }).success).toBe(true)
    }
  })

  it('rejects invalid status', () => {
    const result = CalendarExternalEventSyncPayloadSchema.safeParse({ status: 'draft' })
    expect(result.success).toBe(false)
  })

  it('accepts rawPayload as record', () => {
    const result = CalendarExternalEventSyncPayloadSchema.safeParse({
      rawPayload: { vendor: 'google', data: { id: 'x' } }
    })
    expect(result.success).toBe(true)
  })
})
