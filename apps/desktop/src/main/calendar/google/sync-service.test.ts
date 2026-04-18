import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  createTestDataDb,
  seedInboxItem,
  seedTestData,
  type TestDatabaseResult,
  type TestDb
} from '@tests/utils/test-db'
import { calendarBindings } from '@memry/db-schema/schema/calendar-bindings'
import { calendarEvents } from '@memry/db-schema/schema/calendar-events'
import { calendarExternalEvents } from '@memry/db-schema/schema/calendar-external-events'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import { reminders } from '@memry/db-schema/schema/reminders'
import { tasks } from '@memry/db-schema/schema/tasks'
import { inboxItems } from '@memry/db-schema/schema/inbox'

const { mockCalendarSend } = vi.hoisted(() => ({
  mockCalendarSend: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => [
      {
        webContents: {
          send: mockCalendarSend
        }
      }
    ])
  }
}))

vi.mock('./oauth', () => ({
  hasGoogleCalendarLocalAuth: vi.fn(async () => true),
  hasGoogleCalendarConnection: vi.fn(async () => true)
}))

vi.mock('../../sync/auth-state', () => ({
  isMemryUserSignedIn: vi.fn(async () => true)
}))

import { hasGoogleCalendarConnection, hasGoogleCalendarLocalAuth } from './oauth'
import { isMemryUserSignedIn } from '../../sync/auth-state'
import {
  applyGoogleCalendarDelete,
  applyGoogleCalendarWriteback,
  syncLocalSourceToGoogleCalendar,
  pushSourceToGoogleCalendar,
  syncGoogleCalendarNow,
  syncGoogleCalendarSource
} from './sync-service'

describe('google calendar sync service', () => {
  let dbResult: TestDatabaseResult
  let db: TestDb
  let projectId: string
  let todoStatusId: string

  beforeEach(() => {
    dbResult = createTestDataDb()
    db = dbResult.db
    mockCalendarSend.mockClear()
    vi.mocked(hasGoogleCalendarLocalAuth).mockResolvedValue(true)
    vi.mocked(hasGoogleCalendarConnection).mockResolvedValue(true)
    vi.mocked(isMemryUserSignedIn).mockResolvedValue(true)

    const seeded = seedTestData(db)
    projectId = seeded.projectId
    todoStatusId = seeded.statusIds.todo
  })

  afterEach(() => {
    dbResult.close()
  })

  function seedGoogleCalendarSource(overrides: Partial<typeof calendarSources.$inferInsert> = {}) {
    const now = '2026-04-12T09:00:00.000Z'
    db.insert(calendarSources)
      .values({
        id: 'google-calendar:memry',
        provider: 'google',
        kind: 'calendar',
        accountId: 'google-account:1',
        remoteId: 'remote-memry-calendar',
        title: 'Memry',
        timezone: 'UTC',
        color: '#0f9d58',
        isPrimary: false,
        isSelected: true,
        isMemryManaged: true,
        syncCursor: null,
        syncStatus: 'idle',
        metadata: null,
        clock: { 'device-a': 1 },
        createdAt: now,
        modifiedAt: now,
        ...overrides
      })
      .run()
  }

  it('pushes Memry events, tasks, reminders, and snoozes into Google and persists synced bindings', async () => {
    seedGoogleCalendarSource()

    db.insert(calendarEvents)
      .values({
        id: 'event-1',
        title: 'Team Sync',
        description: 'Discuss launch',
        location: 'Studio',
        startAt: '2026-04-14T09:00:00.000Z',
        endAt: '2026-04-14T10:00:00.000Z',
        timezone: 'UTC',
        isAllDay: false,
        clock: { 'device-a': 1 },
        createdAt: '2026-04-12T09:10:00.000Z',
        modifiedAt: '2026-04-12T09:10:00.000Z'
      })
      .run()

    db.insert(tasks)
      .values({
        id: 'task-google-1',
        projectId,
        statusId: todoStatusId,
        title: 'Draft brief',
        description: 'Due today',
        position: 1,
        dueDate: '2026-04-14',
        dueTime: null,
        clock: { 'device-a': 1 },
        fieldClocks: {},
        createdAt: '2026-04-12T09:15:00.000Z',
        modifiedAt: '2026-04-12T09:15:00.000Z'
      })
      .run()

    db.insert(reminders)
      .values({
        id: 'rem-1',
        targetType: 'note',
        targetId: 'note-1',
        remindAt: '2026-04-14T11:00:00.000Z',
        title: 'Check contract',
        note: 'Need a final pass',
        status: 'pending',
        createdAt: '2026-04-12T09:20:00.000Z',
        modifiedAt: '2026-04-12T09:20:00.000Z'
      })
      .run()

    seedInboxItem(db, {
      id: 'inbox-1',
      type: 'note',
      title: 'Resurface this later',
      content: 'Follow up after lunch',
      snoozedUntil: '2026-04-14T12:00:00.000Z',
      createdAt: '2026-04-12T09:25:00.000Z'
    })

    const client = {
      upsertEvent: vi.fn(async ({ calendarId, eventId, event }) => ({
        id: eventId ?? `remote-${event.sourceType}-${event.sourceId}`,
        calendarId,
        title: event.title,
        description: event.description ?? null,
        location: event.location ?? null,
        startAt: event.startAt,
        endAt: event.endAt ?? null,
        isAllDay: event.isAllDay,
        timezone: event.timezone,
        status: 'confirmed' as const,
        etag: `"etag-${event.sourceId}"`,
        updatedAt: '2026-04-12T09:30:00.000Z',
        raw: { summary: event.title }
      }))
    }

    await pushSourceToGoogleCalendar(db, { sourceType: 'event', sourceId: 'event-1' }, { client })
    await pushSourceToGoogleCalendar(
      db,
      { sourceType: 'task', sourceId: 'task-google-1' },
      { client }
    )
    await pushSourceToGoogleCalendar(db, { sourceType: 'reminder', sourceId: 'rem-1' }, { client })
    await pushSourceToGoogleCalendar(
      db,
      { sourceType: 'inbox_snooze', sourceId: 'inbox-1' },
      { client }
    )

    expect(client.upsertEvent).toHaveBeenCalledTimes(4)
    expect(client.upsertEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        calendarId: 'remote-memry-calendar',
        eventId: null,
        event: expect.objectContaining({
          sourceType: 'event',
          sourceId: 'event-1',
          title: 'Team Sync',
          location: 'Studio',
          isAllDay: false
        })
      })
    )
    expect(client.upsertEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        event: expect.objectContaining({
          sourceType: 'task',
          sourceId: 'task-google-1',
          title: 'Draft brief',
          isAllDay: true
        })
      })
    )
    expect(client.upsertEvent).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        event: expect.objectContaining({
          sourceType: 'reminder',
          sourceId: 'rem-1',
          title: 'Check contract'
        })
      })
    )
    expect(client.upsertEvent).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        event: expect.objectContaining({
          sourceType: 'inbox_snooze',
          sourceId: 'inbox-1',
          title: 'Resurface this later'
        })
      })
    )

    const storedBindings = db
      .select()
      .from(calendarBindings)
      .orderBy(calendarBindings.sourceType)
      .all()

    expect(storedBindings).toHaveLength(4)
    expect(
      storedBindings.map((binding) => [binding.sourceType, binding.sourceId, binding.remoteEventId])
    ).toEqual([
      ['event', 'event-1', 'remote-event-event-1'],
      ['inbox_snooze', 'inbox-1', 'remote-inbox_snooze-inbox-1'],
      ['reminder', 'rem-1', 'remote-reminder-rem-1'],
      ['task', 'task-google-1', 'remote-task-task-google-1']
    ])
  })

  it('writes Google edits back into native Memry records', async () => {
    db.insert(calendarEvents)
      .values({
        id: 'event-1',
        title: 'Old Event',
        description: 'Old description',
        location: 'Old location',
        startAt: '2026-04-14T09:00:00.000Z',
        endAt: '2026-04-14T10:00:00.000Z',
        timezone: 'UTC',
        isAllDay: false,
        clock: { 'device-a': 1 },
        createdAt: '2026-04-12T09:00:00.000Z',
        modifiedAt: '2026-04-12T09:00:00.000Z'
      })
      .run()

    db.insert(tasks)
      .values({
        id: 'task-writeback-1',
        projectId,
        statusId: todoStatusId,
        title: 'Old Task',
        description: 'Old task description',
        position: 1,
        dueDate: '2026-04-14',
        dueTime: null,
        clock: { 'device-a': 1 },
        fieldClocks: {},
        createdAt: '2026-04-12T09:05:00.000Z',
        modifiedAt: '2026-04-12T09:05:00.000Z'
      })
      .run()

    db.insert(reminders)
      .values({
        id: 'rem-1',
        targetType: 'note',
        targetId: 'note-1',
        remindAt: '2026-04-14T11:00:00.000Z',
        title: 'Old Reminder',
        note: 'Old reminder note',
        status: 'pending',
        createdAt: '2026-04-12T09:10:00.000Z',
        modifiedAt: '2026-04-12T09:10:00.000Z'
      })
      .run()

    seedInboxItem(db, {
      id: 'inbox-1',
      type: 'note',
      title: 'Old Snooze',
      content: 'Old content',
      snoozedUntil: '2026-04-14T12:00:00.000Z',
      createdAt: '2026-04-12T09:15:00.000Z'
    })

    await applyGoogleCalendarWriteback(
      db,
      {
        sourceType: 'event',
        sourceId: 'event-1',
        writebackMode: 'broad'
      },
      {
        id: 'remote-event-1',
        calendarId: 'remote-memry-calendar',
        title: 'Updated Event',
        description: 'Updated event description',
        location: 'Updated location',
        startAt: '2026-04-14T13:00:00.000Z',
        endAt: '2026-04-14T14:00:00.000Z',
        isAllDay: false,
        timezone: 'UTC',
        status: 'confirmed',
        etag: '"etag-event"',
        updatedAt: '2026-04-12T10:00:00.000Z',
        raw: {}
      }
    )

    await applyGoogleCalendarWriteback(
      db,
      {
        sourceType: 'task',
        sourceId: 'task-writeback-1',
        writebackMode: 'broad'
      },
      {
        id: 'remote-task-1',
        calendarId: 'remote-memry-calendar',
        title: 'Updated Task',
        description: 'Updated task description',
        location: null,
        startAt: '2026-04-15T15:30:00.000Z',
        endAt: null,
        isAllDay: false,
        timezone: 'UTC',
        status: 'confirmed',
        etag: '"etag-task"',
        updatedAt: '2026-04-12T10:05:00.000Z',
        raw: {}
      }
    )

    await applyGoogleCalendarWriteback(
      db,
      {
        sourceType: 'reminder',
        sourceId: 'rem-1',
        writebackMode: 'broad'
      },
      {
        id: 'remote-rem-1',
        calendarId: 'remote-memry-calendar',
        title: 'Updated Reminder',
        description: 'Updated reminder note',
        location: null,
        startAt: '2026-04-15T16:00:00.000Z',
        endAt: null,
        isAllDay: false,
        timezone: 'UTC',
        status: 'confirmed',
        etag: '"etag-rem"',
        updatedAt: '2026-04-12T10:10:00.000Z',
        raw: {}
      }
    )

    await applyGoogleCalendarWriteback(
      db,
      {
        sourceType: 'inbox_snooze',
        sourceId: 'inbox-1',
        writebackMode: 'broad'
      },
      {
        id: 'remote-inbox-1',
        calendarId: 'remote-memry-calendar',
        title: 'Updated Snooze',
        description: 'Updated snooze content',
        location: null,
        startAt: '2026-04-15T17:00:00.000Z',
        endAt: null,
        isAllDay: false,
        timezone: 'UTC',
        status: 'confirmed',
        etag: '"etag-inbox"',
        updatedAt: '2026-04-12T10:15:00.000Z',
        raw: {}
      }
    )

    expect(
      db.select().from(calendarEvents).where(eq(calendarEvents.id, 'event-1')).get()
    ).toMatchObject({
      title: 'Updated Event',
      description: 'Updated event description',
      location: 'Updated location',
      startAt: '2026-04-14T13:00:00.000Z',
      endAt: '2026-04-14T14:00:00.000Z'
    })

    expect(db.select().from(tasks).where(eq(tasks.id, 'task-writeback-1')).get()).toMatchObject({
      title: 'Updated Task',
      description: 'Updated task description',
      dueDate: '2026-04-15',
      dueTime: '15:30'
    })

    expect(db.select().from(reminders).where(eq(reminders.id, 'rem-1')).get()).toMatchObject({
      title: 'Updated Reminder',
      note: 'Updated reminder note',
      remindAt: '2026-04-15T16:00:00.000Z'
    })

    expect(db.select().from(inboxItems).where(eq(inboxItems.id, 'inbox-1')).get()).toMatchObject({
      title: 'Updated Snooze',
      content: 'Updated snooze content',
      snoozedUntil: '2026-04-15T17:00:00.000Z'
    })
  })

  it('stores imported Google events inside synced calendar tables', async () => {
    seedGoogleCalendarSource({
      id: 'google-calendar:selected',
      remoteId: 'remote-selected-calendar',
      title: 'Work',
      isMemryManaged: false
    })

    const client = {
      listEvents: vi.fn(async () => ({
        nextSyncCursor: 'cursor-2',
        events: [
          {
            id: 'remote-event-1',
            calendarId: 'remote-selected-calendar',
            title: 'Imported review',
            description: 'From Google',
            location: 'Meet',
            startAt: '2026-04-14T13:00:00.000Z',
            endAt: '2026-04-14T14:00:00.000Z',
            isAllDay: false,
            timezone: 'UTC',
            status: 'confirmed' as const,
            etag: '"etag-1"',
            updatedAt: '2026-04-12T10:20:00.000Z',
            raw: { summary: 'Imported review' }
          }
        ]
      }))
    }

    await syncGoogleCalendarSource(db, 'google-calendar:selected', { client })

    const syncedSource = db
      .select()
      .from(calendarSources)
      .where(eq(calendarSources.id, 'google-calendar:selected'))
      .get()
    expect(syncedSource).toMatchObject({
      syncCursor: 'cursor-2',
      syncStatus: 'ok'
    })
    expect(typeof syncedSource?.lastSyncedAt).toBe('string')

    const importedRows = db.select().from(calendarExternalEvents).all()
    expect(importedRows).toHaveLength(1)
    expect(importedRows[0]).toMatchObject({
      sourceId: 'google-calendar:selected',
      remoteEventId: 'remote-event-1',
      title: 'Imported review',
      remoteEtag: '"etag-1"'
    })
  })

  it('reconciles local source mutations by upserting scheduled items and deleting cleared bindings', async () => {
    seedGoogleCalendarSource()

    db.insert(tasks)
      .values({
        id: 'task-reconcile-1',
        projectId,
        statusId: todoStatusId,
        title: 'Calendar task',
        position: 1,
        dueDate: '2026-04-14',
        dueTime: null,
        clock: { 'device-a': 1 },
        fieldClocks: {},
        createdAt: '2026-04-12T09:00:00.000Z',
        modifiedAt: '2026-04-12T09:00:00.000Z'
      })
      .run()

    const client = {
      upsertEvent: vi.fn(async ({ calendarId, eventId, event }) => ({
        id: eventId ?? 'remote-task-reconcile-1',
        calendarId,
        title: event.title,
        description: event.description ?? null,
        location: event.location ?? null,
        startAt: event.startAt,
        endAt: event.endAt ?? null,
        isAllDay: event.isAllDay,
        timezone: event.timezone,
        status: 'confirmed' as const,
        etag: '"etag-reconcile-1"',
        updatedAt: '2026-04-12T10:00:00.000Z',
        raw: {}
      })),
      deleteEvent: vi.fn(async () => {}),
      listCalendars: vi.fn(async () => []),
      createCalendar: vi.fn(async () => ({
        id: 'remote-created',
        title: 'Memry',
        timezone: 'UTC',
        color: null,
        isPrimary: false
      }))
    }

    await syncLocalSourceToGoogleCalendar(
      db,
      { sourceType: 'task', sourceId: 'task-reconcile-1' },
      { client }
    )

    expect(client.upsertEvent).toHaveBeenCalledTimes(1)
    expect(
      db
        .select()
        .from(calendarBindings)
        .where(eq(calendarBindings.sourceId, 'task-reconcile-1'))
        .get()
    ).toMatchObject({
      remoteEventId: 'remote-task-reconcile-1',
      archivedAt: null
    })

    db.update(tasks)
      .set({
        dueDate: null,
        modifiedAt: '2026-04-12T10:05:00.000Z'
      })
      .where(eq(tasks.id, 'task-reconcile-1'))
      .run()

    await syncLocalSourceToGoogleCalendar(
      db,
      { sourceType: 'task', sourceId: 'task-reconcile-1' },
      { client }
    )

    expect(client.deleteEvent).toHaveBeenCalledWith({
      calendarId: 'remote-memry-calendar',
      eventId: 'remote-task-reconcile-1'
    })
    expect(
      db
        .select()
        .from(calendarBindings)
        .where(eq(calendarBindings.sourceId, 'task-reconcile-1'))
        .get()
    ).toMatchObject({
      archivedAt: expect.any(String)
    })
  })

  it('clears scheduling for task, reminder, and snooze bindings when Google deletes the event', async () => {
    db.insert(tasks)
      .values({
        id: 'task-delete-1',
        projectId,
        statusId: todoStatusId,
        title: 'Task survives',
        position: 1,
        dueDate: '2026-04-14',
        dueTime: '09:00',
        clock: { 'device-a': 1 },
        fieldClocks: {},
        createdAt: '2026-04-12T09:00:00.000Z',
        modifiedAt: '2026-04-12T09:00:00.000Z'
      })
      .run()

    db.insert(reminders)
      .values({
        id: 'rem-1',
        targetType: 'note',
        targetId: 'note-1',
        remindAt: '2026-04-14T11:00:00.000Z',
        title: 'Reminder survives',
        status: 'pending',
        createdAt: '2026-04-12T09:05:00.000Z',
        modifiedAt: '2026-04-12T09:05:00.000Z'
      })
      .run()

    seedInboxItem(db, {
      id: 'inbox-1',
      type: 'note',
      title: 'Snooze survives',
      snoozedUntil: '2026-04-14T12:00:00.000Z',
      createdAt: '2026-04-12T09:10:00.000Z'
    })

    await applyGoogleCalendarDelete(db, {
      sourceType: 'task',
      sourceId: 'task-delete-1',
      writebackMode: 'broad'
    })
    await applyGoogleCalendarDelete(db, {
      sourceType: 'reminder',
      sourceId: 'rem-1',
      writebackMode: 'broad'
    })
    await applyGoogleCalendarDelete(db, {
      sourceType: 'inbox_snooze',
      sourceId: 'inbox-1',
      writebackMode: 'broad'
    })

    expect(db.select().from(tasks).where(eq(tasks.id, 'task-delete-1')).get()).toMatchObject({
      title: 'Task survives',
      dueDate: null,
      dueTime: null
    })

    expect(db.select().from(reminders).where(eq(reminders.id, 'rem-1')).get()).toMatchObject({
      title: 'Reminder survives',
      status: 'dismissed'
    })

    expect(db.select().from(inboxItems).where(eq(inboxItems.id, 'inbox-1')).get()).toMatchObject({
      title: 'Snooze survives',
      snoozedUntil: null
    })
  })

  it('skips local Google reconciliation when the device is not connected', async () => {
    seedGoogleCalendarSource()
    vi.mocked(hasGoogleCalendarConnection).mockResolvedValue(false)

    db.insert(tasks)
      .values({
        id: 'task-offline-1',
        projectId,
        statusId: todoStatusId,
        title: 'Offline task',
        position: 1,
        dueDate: '2026-04-14',
        dueTime: null,
        clock: { 'device-a': 1 },
        fieldClocks: {},
        createdAt: '2026-04-12T09:00:00.000Z',
        modifiedAt: '2026-04-12T09:00:00.000Z'
      })
      .run()

    const client = {
      upsertEvent: vi.fn(),
      deleteEvent: vi.fn(),
      listCalendars: vi.fn(),
      createCalendar: vi.fn()
    }

    await expect(
      syncLocalSourceToGoogleCalendar(
        db,
        { sourceType: 'task', sourceId: 'task-offline-1' },
        { client }
      )
    ).resolves.toBeNull()

    expect(client.upsertEvent).not.toHaveBeenCalled()
    expect(client.deleteEvent).not.toHaveBeenCalled()
  })

  it('routes Google updates for bound events through applyGoogleCalendarWriteback instead of the mirror', async () => {
    // #given a selected non-managed source with an active binding for one remote event
    const now = '2026-04-18T09:00:00.000Z'
    db.insert(calendarSources)
      .values({
        id: 'google-calendar:selected',
        provider: 'google',
        kind: 'calendar',
        accountId: 'google-account:1',
        remoteId: 'remote-selected-calendar',
        title: 'Personal',
        timezone: 'UTC',
        color: null,
        isPrimary: false,
        isSelected: true,
        isMemryManaged: false,
        syncCursor: 'cursor-1',
        syncStatus: 'ok',
        metadata: null,
        clock: { 'device-a': 1 },
        createdAt: now,
        modifiedAt: now
      })
      .run()

    db.insert(calendarEvents)
      .values({
        id: 'event-bound-1',
        title: 'Old title',
        description: null,
        location: null,
        startAt: '2026-04-20T09:00:00.000Z',
        endAt: '2026-04-20T10:00:00.000Z',
        timezone: 'UTC',
        isAllDay: false,
        clock: { 'device-a': 1 },
        createdAt: now,
        modifiedAt: now
      })
      .run()

    db.insert(calendarBindings)
      .values({
        id: 'binding-bound-1',
        sourceType: 'event',
        sourceId: 'event-bound-1',
        provider: 'google',
        remoteCalendarId: 'remote-selected-calendar',
        remoteEventId: 'remote-event-bound-1',
        ownershipMode: 'memry_managed',
        writebackMode: 'broad',
        remoteVersion: '"etag-old"',
        lastLocalSnapshot: null,
        archivedAt: null,
        clock: { 'device-a': 1 },
        syncedAt: now,
        createdAt: now,
        modifiedAt: now
      })
      .run()

    const client = {
      listEvents: vi.fn(async () => ({
        nextSyncCursor: 'cursor-2',
        events: [
          {
            id: 'remote-event-bound-1',
            calendarId: 'remote-selected-calendar',
            title: 'Updated from Google',
            description: 'Updated description',
            location: 'Updated location',
            startAt: '2026-04-20T11:00:00.000Z',
            endAt: '2026-04-20T12:00:00.000Z',
            isAllDay: false,
            timezone: 'UTC',
            status: 'confirmed' as const,
            etag: '"etag-new"',
            updatedAt: '2026-04-18T08:00:00.000Z',
            raw: {}
          }
        ]
      }))
    }

    // #when
    await syncGoogleCalendarSource(db, 'google-calendar:selected', { client })

    // #then: the native row was updated, the mirror was NOT, the binding etag refreshed
    const updatedEvent = db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.id, 'event-bound-1'))
      .get()
    expect(updatedEvent).toMatchObject({
      title: 'Updated from Google',
      description: 'Updated description',
      location: 'Updated location',
      startAt: '2026-04-20T11:00:00.000Z',
      endAt: '2026-04-20T12:00:00.000Z'
    })

    const mirrorRows = db.select().from(calendarExternalEvents).all()
    expect(mirrorRows).toHaveLength(0)

    const refreshedBinding = db
      .select()
      .from(calendarBindings)
      .where(eq(calendarBindings.id, 'binding-bound-1'))
      .get()
    expect(refreshedBinding?.remoteVersion).toBe('"etag-new"')
  })

  describe('syncGoogleCalendarNow gating', () => {
    function buildClient() {
      return {
        listCalendars: vi.fn(),
        createCalendar: vi.fn(),
        listEvents: vi.fn(),
        upsertEvent: vi.fn(),
        deleteEvent: vi.fn()
      }
    }

    it('skips all Google API calls when Memry user is not signed in', async () => {
      vi.mocked(isMemryUserSignedIn).mockResolvedValue(false)
      const client = buildClient()

      await syncGoogleCalendarNow(db, { client })

      expect(client.listCalendars).not.toHaveBeenCalled()
      expect(client.listEvents).not.toHaveBeenCalled()
    })

    it('skips all Google API calls when no Google Calendar connection exists', async () => {
      vi.mocked(hasGoogleCalendarConnection).mockResolvedValue(false)
      const client = buildClient()

      await syncGoogleCalendarNow(db, { client })

      expect(client.listCalendars).not.toHaveBeenCalled()
      expect(client.listEvents).not.toHaveBeenCalled()
    })
  })
})
