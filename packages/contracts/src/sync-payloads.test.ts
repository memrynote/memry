/**
 * Sync Payload Contract Tests
 *
 * Per-item-type encrypted payload shapes consumed by sync item handlers.
 * Covers optional-field tolerance, nullable-string handling, and Phase 8
 * field-clock regression (fieldClocks on tasks/projects).
 */

import { describe, it, expect } from 'vitest'

import {
  AgentMessageSyncPayloadSchema,
  BookmarkSyncPayloadSchema,
  CalendarBindingSyncPayloadSchema,
  CalendarEventSyncPayloadSchema,
  CalendarExternalEventSyncPayloadSchema,
  CalendarSourceSyncPayloadSchema,
  CanvasFolderSyncPayloadSchema,
  CanvasSyncPayloadSchema,
  FilterSyncPayloadSchema,
  FolderConfigSyncPayloadSchema,
  InboxSyncPayloadSchema,
  JournalSyncPayloadSchema,
  NoteSyncPayloadSchema,
  ProjectSyncPayloadSchema,
  ReminderSyncPayloadSchema,
  StatusSyncSchema,
  TagDefinitionSyncPayloadSchema,
  TaskActivitySyncPayloadSchema,
  TaskSyncPayloadSchema,
  TemplateSyncPayloadSchema
} from './sync-payloads'

import {
  SYNC_ITEM_TYPES,
  RECORD_SYNC_ITEM_TYPES,
  RECORD_CLOCK_REQUIRED_ITEM_TYPES,
  ENCRYPTABLE_ITEM_TYPES,
  CRDT_SYNC_ITEM_TYPES,
  LEGACY_RECORD_SYNC_ITEM_TYPES
} from './sync-api'

describe('AgentMessageSyncPayloadSchema', () => {
  it('accepts inbox and calendar event attachments', () => {
    const result = AgentMessageSyncPayloadSchema.safeParse({
      conversationId: 'conversation-1',
      role: 'user',
      content: { role: 'user', data: { text: 'Summarize these refs' } },
      attachments: [
        {
          kind: 'inbox',
          refId: 'inbox-1',
          label: 'Read later',
          snapshotAt: 100,
          snapshot: { mode: 'reference_only', id: 'inbox-1' }
        },
        {
          kind: 'calendar_event',
          refId: 'event-1',
          label: 'Planning sync',
          snapshotAt: 100,
          snapshot: { mode: 'reference_only', id: 'event-1' }
        }
      ],
      toolCallId: null,
      status: 'completed',
      createdAt: 100,
      updatedAt: 100,
      deletedAt: null
    })

    expect(result.success).toBe(true)
  })
})

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

describe('TaskActivitySyncPayloadSchema', () => {
  it('accepts a full row', () => {
    const result = TaskActivitySyncPayloadSchema.safeParse({
      taskId: 'task-1',
      action: 'updated',
      field: 'dueDate',
      oldValue: '"2026-08-12"',
      newValue: '"2026-08-20"',
      actor: 'user',
      deviceId: 'device-A',
      clock: { 'device-A': 3 },
      createdAt: '2026-08-13T10:00:00.000Z'
    })
    expect(result.success).toBe(true)
  })

  it('accepts null field/values — description rows never carry the body text', () => {
    const result = TaskActivitySyncPayloadSchema.safeParse({
      taskId: 'task-1',
      action: 'updated',
      field: 'description',
      oldValue: null,
      newValue: null
    })
    expect(result.success).toBe(true)
  })

  it('accepts an empty payload (all optional, forward-tolerant per D5)', () => {
    expect(TaskActivitySyncPayloadSchema.safeParse({}).success).toBe(true)
  })

  it('rejects a non-string action', () => {
    expect(TaskActivitySyncPayloadSchema.safeParse({ action: 3 }).success).toBe(false)
  })
})

describe('CanvasSyncPayloadSchema', () => {
  it('accepts an empty payload (all optional, forward-tolerant per D5)', () => {
    expect(CanvasSyncPayloadSchema.safeParse({}).success).toBe(true)
  })

  it('accepts a full payload', () => {
    const result = CanvasSyncPayloadSchema.safeParse({
      id: 'canvas-1',
      vaultId: 'vault-1',
      title: 'My Canvas',
      scene: '{"type":"excalidraw","elements":[]}',
      clock: { 'device-a': 3 },
      deletedAt: null
    })
    expect(result.success).toBe(true)
  })

  it('accepts a null title and null deletedAt', () => {
    expect(CanvasSyncPayloadSchema.safeParse({ title: null, deletedAt: null }).success).toBe(true)
  })

  it('rejects a non-string scene', () => {
    expect(CanvasSyncPayloadSchema.safeParse({ scene: 42 }).success).toBe(false)
  })

  it('rejects a clock with a negative tick', () => {
    expect(CanvasSyncPayloadSchema.safeParse({ clock: { 'device-a': -1 } }).success).toBe(false)
  })

  it('carries folder and icon through a new-shape payload', () => {
    const parsed = CanvasSyncPayloadSchema.safeParse({
      id: 'canvas-1',
      title: 'Plan',
      scene: '{}',
      folder: 'Work/Q3',
      icon: '🎨'
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.folder).toBe('Work/Q3')
    expect(parsed.data?.icon).toBe('🎨')
  })

  it('accepts null folder and null icon (explicit root, no icon)', () => {
    const parsed = CanvasSyncPayloadSchema.safeParse({ folder: null, icon: null })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.folder).toBeNull()
    expect(parsed.data?.icon).toBeNull()
  })

  it('parses an old-shape payload with no folder or icon', () => {
    const parsed = CanvasSyncPayloadSchema.safeParse({ id: 'c1', title: 'Plan', scene: '{}' })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.folder).toBeUndefined()
    expect(parsed.data?.icon).toBeUndefined()
  })

  it('rejects a non-string folder', () => {
    expect(CanvasSyncPayloadSchema.safeParse({ folder: 42 }).success).toBe(false)
  })
})

describe('CanvasFolderSyncPayloadSchema', () => {
  it('parses a full payload', () => {
    const parsed = CanvasFolderSyncPayloadSchema.safeParse({
      id: 'cvf_work',
      vaultId: 'v1',
      path: 'Work',
      icon: '📁',
      clock: { deviceA: 1 },
      deletedAt: null
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.path).toBe('Work')
    expect(parsed.data?.icon).toBe('📁')
  })

  it('parses an empty payload from a future client', () => {
    expect(CanvasFolderSyncPayloadSchema.safeParse({}).success).toBe(true)
  })

  it('rejects a non-string path', () => {
    expect(CanvasFolderSyncPayloadSchema.safeParse({ path: 42 }).success).toBe(false)
  })

  it('rejects a clock with a negative tick', () => {
    expect(CanvasFolderSyncPayloadSchema.safeParse({ clock: { deviceA: -1 } }).success).toBe(false)
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

  it('accepts a delete tombstone that omits the date', () => {
    // Deletes carry no user data: the receiver short-circuits on
    // `operation === 'delete'` and never decodes the body, so the journalled
    // day was uploaded on every delete for nothing. See
    // journal-sync.buildDeletePayload. An upsert without a date is still
    // rejected — by journal-handler.applyUpsert, not by this schema.
    const result = JournalSyncPayloadSchema.safeParse({
      clock: { 'device-a': 4 },
      createdAt: '2026-04-16T00:00:00Z',
      modifiedAt: '2026-04-16T01:00:00Z'
    })
    expect(result.success).toBe(true)
  })

  it('still accepts a dated tombstone from a sender that predates the change', () => {
    // Old sender -> new receiver: the field is optional now, not removed.
    const result = JournalSyncPayloadSchema.safeParse({
      date: '2026-04-16',
      clock: { 'device-a': 4 },
      createdAt: '2026-04-16T00:00:00Z',
      modifiedAt: '2026-04-16T01:00:00Z'
    })
    expect(result.success).toBe(true)
  })

  it('rejects a non-string date', () => {
    const result = JournalSyncPayloadSchema.safeParse({ date: 20260416 })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('date')
    }
  })
})

describe('TagDefinitionSyncPayloadSchema', () => {
  it('accepts minimal required fields', () => {
    expect(TagDefinitionSyncPayloadSchema.safeParse({ name: 'work', color: '#abc' }).success).toBe(
      true
    )
  })

  it('rejects missing color', () => {
    expect(TagDefinitionSyncPayloadSchema.safeParse({ name: 'work' }).success).toBe(false)
  })

  it('accepts a views array', () => {
    const result = TagDefinitionSyncPayloadSchema.safeParse({
      name: 'work',
      color: '#abc',
      views: [{ name: 'Mine', type: 'table' }]
    })
    expect(result.success).toBe(true)
  })

  it('accepts explicit null views (clear)', () => {
    expect(
      TagDefinitionSyncPayloadSchema.safeParse({ name: 'work', color: '#abc', views: null }).success
    ).toBe(true)
  })

  it('tolerates an old payload with no views key (backward compat, project_links-style regression)', () => {
    const parsed = TagDefinitionSyncPayloadSchema.parse({ name: 'work', color: '#abc' })
    expect(parsed.views).toBeUndefined()
  })

  it('rejects a non-array views value', () => {
    const result = TagDefinitionSyncPayloadSchema.safeParse({
      name: 'work',
      color: '#abc',
      views: 'not-an-array'
    })
    expect(result.success).toBe(false)
  })

  it('rejects a views entry missing the required name', () => {
    const result = TagDefinitionSyncPayloadSchema.safeParse({
      name: 'work',
      color: '#abc',
      views: [{ type: 'table' }]
    })
    expect(result.success).toBe(false)
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
    expect(CalendarSourceSyncPayloadSchema.safeParse({ kind: 'account' }).success).toBe(true)
    expect(CalendarSourceSyncPayloadSchema.safeParse({ kind: 'calendar' }).success).toBe(true)
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
    expect(CalendarBindingSyncPayloadSchema.safeParse({ lastLocalSnapshot: null }).success).toBe(
      true
    )
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

describe('ProjectSyncPayloadSchema — links + homeNoteId', () => {
  it('#then parses a payload carrying links and homeNoteId', () => {
    const parsed = ProjectSyncPayloadSchema.parse({
      name: 'P',
      homeNoteId: 'note-1',
      links: [{ id: 'l1', itemType: 'note', itemId: 'n1', position: 0 }]
    })
    expect(parsed.links).toHaveLength(1)
    expect(parsed.homeNoteId).toBe('note-1')
  })

  it('#then tolerates an old payload with no links key (backward compat)', () => {
    const parsed = ProjectSyncPayloadSchema.parse({ name: 'P' })
    expect(parsed.links).toBeUndefined()
    expect(parsed.homeNoteId).toBeUndefined()
  })
})

describe('BookmarkSyncPayloadSchema', () => {
  it('parses a full payload', () => {
    const result = BookmarkSyncPayloadSchema.safeParse({
      itemType: 'note',
      itemId: 'note_1',
      position: 3,
      createdAt: '2026-08-02T00:00:00.000Z',
      clock: { device_a: 2 }
    })
    expect(result.success).toBe(true)
  })

  it('parses an empty payload (forward tolerance)', () => {
    expect(BookmarkSyncPayloadSchema.safeParse({}).success).toBe(true)
  })

  it('ignores unknown fields from a newer client', () => {
    const result = BookmarkSyncPayloadSchema.safeParse({ itemId: 'n1', futureField: 'x' })
    expect(result.success).toBe(true)
  })
})

describe('ReminderSyncPayloadSchema', () => {
  it('parses a full payload', () => {
    const result = ReminderSyncPayloadSchema.safeParse({
      targetType: 'note',
      targetId: 'note_1',
      remindAt: '2026-08-03T09:00:00.000Z',
      anchorId: 'anchor_1',
      highlightText: 'hello',
      highlightStart: 0,
      highlightEnd: 5,
      title: 'Check this',
      note: 'because',
      status: 'pending',
      dismissedAt: null,
      snoozedUntil: null,
      createdAt: '2026-08-02T00:00:00.000Z',
      modifiedAt: '2026-08-02T00:00:00.000Z',
      clock: { device_a: 1 }
    })
    expect(result.success).toBe(true)
  })

  it('parses an empty payload (forward tolerance)', () => {
    expect(ReminderSyncPayloadSchema.safeParse({}).success).toBe(true)
  })

  it('has no triggeredAt field — it is device-local', () => {
    const parsed = ReminderSyncPayloadSchema.parse({ triggeredAt: '2026-08-02T00:00:00.000Z' })
    expect('triggeredAt' in parsed).toBe(false)
  })
})

describe('template sync item type', () => {
  it('is registered in all four required arrays', () => {
    expect(SYNC_ITEM_TYPES).toContain('template')
    expect(RECORD_SYNC_ITEM_TYPES).toContain('template')
    expect(RECORD_CLOCK_REQUIRED_ITEM_TYPES).toContain('template')
    // Omitting this one makes encryption refuse the type and sync drops it silently.
    expect(ENCRYPTABLE_ITEM_TYPES).toContain('template')
  })

  it('is not a CRDT type and never leaks into the frozen legacy list', () => {
    expect(CRDT_SYNC_ITEM_TYPES).not.toContain('template')
    expect(LEGACY_RECORD_SYNC_ITEM_TYPES).not.toContain('template')
  })
})

describe('TemplateSyncPayloadSchema', () => {
  it('parses a full payload', () => {
    const result = TemplateSyncPayloadSchema.safeParse({
      name: 'Standup',
      description: 'Daily standup',
      icon: '✅',
      tags: ['daily'],
      properties: [{ name: 'date', type: 'date', value: null }],
      content: '## Blockers',
      clock: { 'device-a': 1 },
      createdAt: '2026-07-16T00:00:00.000Z',
      modifiedAt: '2026-07-16T00:00:00.000Z'
    })
    expect(result.success).toBe(true)
  })

  it('parses an empty payload (every field optional)', () => {
    expect(TemplateSyncPayloadSchema.safeParse({}).success).toBe(true)
  })

  it('accepts a null icon and null description', () => {
    const result = TemplateSyncPayloadSchema.safeParse({ icon: null, description: null })
    expect(result.success).toBe(true)
  })
})
