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
import { settings } from '@memry/db-schema/schema/settings'
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

  it('deletes the native record when a bound Google event is cancelled', async () => {
    // #given a selected source, a native calendar_events row, and a binding
    const now = '2026-04-18T09:00:00.000Z'
    seedGoogleCalendarSource({
      id: 'google-calendar:selected',
      remoteId: 'remote-selected-calendar',
      title: 'Personal',
      color: null,
      isMemryManaged: false,
      syncCursor: 'cursor-1',
      syncStatus: 'ok'
    })

    db.insert(calendarEvents)
      .values({
        id: 'event-bound-delete',
        title: 'About to be deleted',
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
        id: 'binding-bound-delete',
        sourceType: 'event',
        sourceId: 'event-bound-delete',
        provider: 'google',
        remoteCalendarId: 'remote-selected-calendar',
        remoteEventId: 'remote-event-bound-delete',
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
            id: 'remote-event-bound-delete',
            calendarId: 'remote-selected-calendar',
            title: 'About to be deleted',
            description: null,
            location: null,
            startAt: '2026-04-20T09:00:00.000Z',
            endAt: '2026-04-20T10:00:00.000Z',
            isAllDay: false,
            timezone: 'UTC',
            status: 'cancelled' as const,
            etag: '"etag-cancelled"',
            updatedAt: '2026-04-18T08:30:00.000Z',
            raw: {}
          }
        ]
      }))
    }

    // #when
    await syncGoogleCalendarSource(db, 'google-calendar:selected', { client })

    // #then: native row gone, binding archived, mirror untouched
    const survivingEvent = db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.id, 'event-bound-delete'))
      .get()
    expect(survivingEvent).toBeUndefined()

    const archivedBinding = db
      .select()
      .from(calendarBindings)
      .where(eq(calendarBindings.id, 'binding-bound-delete'))
      .get()
    expect(archivedBinding?.archivedAt).toBeTruthy()

    const mirrorRows = db.select().from(calendarExternalEvents).all()
    expect(mirrorRows).toHaveLength(0)
  })

  it('archives the mirror row when an unbound Google event is cancelled', async () => {
    // #given a selected source with an existing mirror row and no binding
    const now = '2026-04-18T09:00:00.000Z'
    seedGoogleCalendarSource({
      id: 'google-calendar:selected',
      remoteId: 'remote-selected-calendar',
      title: 'Personal',
      color: null,
      isMemryManaged: false,
      syncCursor: 'cursor-1',
      syncStatus: 'ok'
    })

    db.insert(calendarExternalEvents)
      .values({
        id: 'calendar_external_event:google-calendar:selected:remote-unbound-1',
        sourceId: 'google-calendar:selected',
        remoteEventId: 'remote-unbound-1',
        remoteEtag: '"etag-old"',
        remoteUpdatedAt: '2026-04-18T07:00:00.000Z',
        title: 'External event',
        description: null,
        location: null,
        startAt: '2026-04-20T09:00:00.000Z',
        endAt: '2026-04-20T10:00:00.000Z',
        timezone: 'UTC',
        isAllDay: false,
        status: 'confirmed',
        recurrenceRule: null,
        rawPayload: {},
        archivedAt: null,
        clock: { 'device-a': 1 },
        createdAt: now,
        modifiedAt: now
      })
      .run()

    const client = {
      listEvents: vi.fn(async () => ({
        nextSyncCursor: 'cursor-2',
        events: [
          {
            id: 'remote-unbound-1',
            calendarId: 'remote-selected-calendar',
            title: 'External event',
            description: null,
            location: null,
            startAt: '2026-04-20T09:00:00.000Z',
            endAt: '2026-04-20T10:00:00.000Z',
            isAllDay: false,
            timezone: 'UTC',
            status: 'cancelled' as const,
            etag: '"etag-cancelled"',
            updatedAt: '2026-04-18T08:45:00.000Z',
            raw: {}
          }
        ]
      }))
    }

    // #when
    await syncGoogleCalendarSource(db, 'google-calendar:selected', { client })

    // #then: the mirror row is archived (archivedAt set), not deleted
    const mirrorRow = db
      .select()
      .from(calendarExternalEvents)
      .where(
        eq(
          calendarExternalEvents.id,
          'calendar_external_event:google-calendar:selected:remote-unbound-1'
        )
      )
      .get()
    expect(mirrorRow?.archivedAt).toBeTruthy()
  })

  it('does not materialize a mirror row when an unbound Google event arrives already cancelled', async () => {
    // #given a selected source with NO existing mirror row and NO binding
    seedGoogleCalendarSource({
      id: 'google-calendar:selected',
      remoteId: 'remote-selected-calendar',
      title: 'Personal',
      color: null,
      isMemryManaged: false,
      syncCursor: 'cursor-1',
      syncStatus: 'ok'
    })

    const client = {
      listEvents: vi.fn(async () => ({
        nextSyncCursor: 'cursor-2',
        events: [
          {
            id: 'remote-never-seen-1',
            calendarId: 'remote-selected-calendar',
            title: 'Cancelled before we saw it',
            description: null,
            location: null,
            startAt: '2026-04-20T09:00:00.000Z',
            endAt: '2026-04-20T10:00:00.000Z',
            isAllDay: false,
            timezone: 'UTC',
            status: 'cancelled' as const,
            etag: '"etag-cancelled"',
            updatedAt: '2026-04-18T08:45:00.000Z',
            raw: {}
          }
        ]
      }))
    }

    // #when
    await syncGoogleCalendarSource(db, 'google-calendar:selected', { client })

    // #then: no mirror row was created (no tombstone for events we never saw)
    const mirrorRows = db.select().from(calendarExternalEvents).all()
    expect(mirrorRows).toHaveLength(0)
  })

  it('recovers from a 410 Gone by clearing syncCursor and re-syncing', async () => {
    // #given a selected source with a stale syncCursor
    seedGoogleCalendarSource({
      id: 'google-calendar:selected',
      remoteId: 'remote-selected-calendar',
      title: 'Personal',
      color: null,
      isMemryManaged: false,
      syncCursor: 'stale-cursor',
      syncStatus: 'ok'
    })

    const goneError = Object.assign(new Error('Gone'), { status: 410 })
    const listEvents = vi.fn().mockRejectedValueOnce(goneError).mockResolvedValueOnce({
      nextSyncCursor: 'cursor-fresh',
      events: []
    })

    const client = { listEvents }

    // #when
    await syncGoogleCalendarSource(db, 'google-calendar:selected', { client })

    // #then: listEvents called twice — once with the stale cursor, once with null
    expect(listEvents).toHaveBeenCalledTimes(2)
    expect(listEvents.mock.calls[0]?.[0]).toMatchObject({ syncCursor: 'stale-cursor' })
    expect(listEvents.mock.calls[1]?.[0]).toMatchObject({ syncCursor: null })

    const refreshedSource = db
      .select()
      .from(calendarSources)
      .where(eq(calendarSources.id, 'google-calendar:selected'))
      .get()
    expect(refreshedSource?.syncCursor).toBe('cursor-fresh')
  })

  describe('pushSourceToGoogleCalendar — M3 etag + field-clock conflict resolution', () => {
    it('on 412 Precondition Failed, pulls latest, merges fields, retries with fresh etag', async () => {
      // #given a bound Memry event with stale binding etag and field clocks favoring local
      seedGoogleCalendarSource({
        id: 'google-calendar:user-cal',
        remoteId: 'remote-user-cal',
        isMemryManaged: false
      })

      const localFC = {
        title: { 'device-a': 2 },
        description: { 'device-a': 1 },
        location: { 'device-a': 1 },
        startAt: { 'device-a': 1 },
        endAt: { 'device-a': 1 },
        timezone: { 'device-a': 1 },
        isAllDay: { 'device-a': 1 },
        recurrenceRule: { 'device-a': 1 },
        recurrenceExceptions: { 'device-a': 1 }
      }

      db.insert(calendarEvents)
        .values({
          id: 'event-conflict',
          title: 'Local title (renamed by A)',
          description: 'Original description',
          location: null,
          startAt: '2026-04-20T09:00:00.000Z',
          endAt: '2026-04-20T10:00:00.000Z',
          timezone: 'UTC',
          isAllDay: false,
          targetCalendarId: 'remote-user-cal',
          clock: { 'device-a': 2 },
          fieldClocks: localFC,
          createdAt: '2026-04-20T08:00:00.000Z',
          modifiedAt: '2026-04-20T08:30:00.000Z'
        })
        .run()

      db.insert(calendarBindings)
        .values({
          id: 'binding-conflict',
          sourceType: 'event',
          sourceId: 'event-conflict',
          provider: 'google',
          remoteCalendarId: 'remote-user-cal',
          remoteEventId: 'remote-event-conflict',
          ownershipMode: 'memry_managed',
          writebackMode: 'broad',
          remoteVersion: '"etag-stale"',
          lastLocalSnapshot: null,
          archivedAt: null,
          clock: { 'device-a': 1 },
          syncedAt: '2026-04-20T08:00:00.000Z',
          createdAt: '2026-04-20T08:00:00.000Z',
          modifiedAt: '2026-04-20T08:00:00.000Z'
        })
        .run()

      const conflict = Object.assign(new Error('Precondition Failed'), { status: 412 })
      const upsertCalls: Array<{ ifMatch?: string | null; eventTitle: string }> = []

      const upsertEvent = vi.fn(
        async (input: {
          calendarId: string
          eventId: string | null
          ifMatch?: string | null
          event: { title: string; description: string | null }
        }) => {
          upsertCalls.push({ ifMatch: input.ifMatch, eventTitle: input.event.title })
          if (upsertCalls.length === 1) throw conflict
          return {
            id: 'remote-event-conflict',
            calendarId: input.calendarId,
            title: input.event.title,
            description: input.event.description,
            location: null,
            startAt: '2026-04-20T09:00:00.000Z',
            endAt: '2026-04-20T10:00:00.000Z',
            isAllDay: false,
            timezone: 'UTC',
            status: 'confirmed' as const,
            etag: '"etag-merged"',
            updatedAt: '2026-04-20T08:35:00.000Z',
            raw: {}
          }
        }
      )

      // Remote-side state: device-b changed description but did NOT touch title
      const getEvent = vi.fn(async () => ({
        id: 'remote-event-conflict',
        calendarId: 'remote-user-cal',
        title: 'Local title (renamed by A)',
        description: 'Edited remotely by B',
        location: null,
        startAt: '2026-04-20T09:00:00.000Z',
        endAt: '2026-04-20T10:00:00.000Z',
        isAllDay: false,
        timezone: 'UTC',
        status: 'confirmed' as const,
        etag: '"etag-fresh"',
        updatedAt: '2026-04-20T08:33:00.000Z',
        raw: {}
      }))

      const client = {
        upsertEvent,
        getEvent,
        listCalendars: vi.fn(async () => []),
        createCalendar: vi.fn()
      }

      // #when
      await pushSourceToGoogleCalendar(
        db,
        { sourceType: 'event', sourceId: 'event-conflict' },
        { client }
      )

      // #then: 1st upsert with stale etag → 412, getEvent fetched fresh, 2nd upsert with fresh etag
      expect(upsertCalls).toHaveLength(2)
      expect(upsertCalls[0].ifMatch).toBe('"etag-stale"')
      expect(upsertCalls[1].ifMatch).toBe('"etag-fresh"')
      expect(getEvent).toHaveBeenCalledTimes(1)

      const refreshed = db
        .select()
        .from(calendarBindings)
        .where(eq(calendarBindings.id, 'binding-conflict'))
        .get()
      expect(refreshed?.remoteVersion).toBe('"etag-merged"')

      // Local row received the merged remote description (no local edit there)
      const refreshedEvent = db
        .select()
        .from(calendarEvents)
        .where(eq(calendarEvents.id, 'event-conflict'))
        .get()
      expect(refreshedEvent?.description).toBe('Edited remotely by B')
      expect(refreshedEvent?.title).toBe('Local title (renamed by A)')
    })

    it('after 3 consecutive 412s, marks the binding as conflict and stops retrying', async () => {
      // #given a bound Memry event whose remote keeps changing between attempts
      seedGoogleCalendarSource({
        id: 'google-calendar:user-cal-2',
        remoteId: 'remote-user-cal-2',
        isMemryManaged: false
      })

      db.insert(calendarEvents)
        .values({
          id: 'event-strikeout',
          title: 'Local',
          startAt: '2026-04-20T09:00:00.000Z',
          endAt: '2026-04-20T10:00:00.000Z',
          timezone: 'UTC',
          isAllDay: false,
          targetCalendarId: 'remote-user-cal-2',
          clock: { 'device-a': 1 },
          fieldClocks: null,
          createdAt: '2026-04-20T08:00:00.000Z',
          modifiedAt: '2026-04-20T08:30:00.000Z'
        })
        .run()

      db.insert(calendarBindings)
        .values({
          id: 'binding-strikeout',
          sourceType: 'event',
          sourceId: 'event-strikeout',
          provider: 'google',
          remoteCalendarId: 'remote-user-cal-2',
          remoteEventId: 'remote-event-strikeout',
          ownershipMode: 'memry_managed',
          writebackMode: 'broad',
          remoteVersion: '"etag-attempt-0"',
          lastLocalSnapshot: null,
          archivedAt: null,
          clock: { 'device-a': 1 },
          syncedAt: '2026-04-20T08:00:00.000Z',
          createdAt: '2026-04-20T08:00:00.000Z',
          modifiedAt: '2026-04-20T08:00:00.000Z'
        })
        .run()

      const conflict = Object.assign(new Error('Precondition'), { status: 412 })
      const upsertEvent = vi.fn(async () => {
        throw conflict
      })
      let etagCounter = 1
      const getEvent = vi.fn(async () => ({
        id: 'remote-event-strikeout',
        calendarId: 'remote-user-cal-2',
        title: `Remote ${etagCounter}`,
        description: null,
        location: null,
        startAt: '2026-04-20T09:00:00.000Z',
        endAt: '2026-04-20T10:00:00.000Z',
        isAllDay: false,
        timezone: 'UTC',
        status: 'confirmed' as const,
        etag: `"etag-attempt-${etagCounter++}"`,
        updatedAt: '2026-04-20T08:33:00.000Z',
        raw: {}
      }))

      const client = {
        upsertEvent,
        getEvent,
        listCalendars: vi.fn(async () => []),
        createCalendar: vi.fn()
      }

      // #when (expect throw OR conflict-marked binding — design says "stop retrying")
      await expect(
        pushSourceToGoogleCalendar(
          db,
          { sourceType: 'event', sourceId: 'event-strikeout' },
          { client }
        )
      ).rejects.toThrow()

      // #then: exactly 3 upsert attempts (no 4th) + binding marked conflict
      expect(upsertEvent).toHaveBeenCalledTimes(3)

      const refreshed = db
        .select()
        .from(calendarBindings)
        .where(eq(calendarBindings.id, 'binding-strikeout'))
        .get()
      expect(refreshed?.remoteVersion).toBe('conflict')
    })

    it('on a second 412 with a newer remote field value, the newer remote value wins (Codex P2)', async () => {
      // #given a bound event whose local title was already merged once with Google;
      //        a second remote edit changes the title again and the push 412s.
      seedGoogleCalendarSource({
        id: 'google-calendar:user-cal-3',
        remoteId: 'remote-user-cal-3',
        isMemryManaged: false
      })

      // After a first merge, local field clocks have grown
      // (mimicking state right after one 412 round-trip already completed).
      const localFC = {
        title: { 'device-a': 5 },
        description: { 'device-a': 5 },
        location: { 'device-a': 5 },
        startAt: { 'device-a': 5 },
        endAt: { 'device-a': 5 },
        timezone: { 'device-a': 5 },
        isAllDay: { 'device-a': 5 },
        recurrenceRule: { 'device-a': 5 },
        recurrenceExceptions: { 'device-a': 5 }
      }

      db.insert(calendarEvents)
        .values({
          id: 'event-second-conflict',
          title: 'Local title (merged earlier)',
          description: null,
          location: null,
          startAt: '2026-04-20T09:00:00.000Z',
          endAt: '2026-04-20T10:00:00.000Z',
          timezone: 'UTC',
          isAllDay: false,
          targetCalendarId: 'remote-user-cal-3',
          clock: { 'device-a': 5 },
          fieldClocks: localFC,
          createdAt: '2026-04-20T08:00:00.000Z',
          modifiedAt: '2026-04-20T08:30:00.000Z'
        })
        .run()

      db.insert(calendarBindings)
        .values({
          id: 'binding-second-conflict',
          sourceType: 'event',
          sourceId: 'event-second-conflict',
          provider: 'google',
          remoteCalendarId: 'remote-user-cal-3',
          remoteEventId: 'remote-event-second-conflict',
          ownershipMode: 'memry_managed',
          writebackMode: 'broad',
          remoteVersion: '"etag-prev-merged"',
          lastLocalSnapshot: null,
          archivedAt: null,
          clock: { 'device-a': 1 },
          syncedAt: '2026-04-20T08:00:00.000Z',
          createdAt: '2026-04-20T08:00:00.000Z',
          modifiedAt: '2026-04-20T08:00:00.000Z'
        })
        .run()

      const conflict = Object.assign(new Error('Precondition Failed'), { status: 412 })
      const upsertEvent = vi.fn(async (input: { ifMatch?: string | null }) => {
        if (input.ifMatch === '"etag-prev-merged"') throw conflict
        return {
          id: 'remote-event-second-conflict',
          calendarId: 'remote-user-cal-3',
          title: 'Local title (merged earlier)',
          description: null,
          location: null,
          startAt: '2026-04-20T09:00:00.000Z',
          endAt: '2026-04-20T10:00:00.000Z',
          isAllDay: false,
          timezone: 'UTC',
          status: 'confirmed' as const,
          etag: '"etag-final"',
          updatedAt: '2026-04-20T08:35:00.000Z',
          raw: {}
        }
      })
      const getEvent = vi.fn(async () => ({
        id: 'remote-event-second-conflict',
        calendarId: 'remote-user-cal-3',
        title: 'Brand new remote title',
        description: null,
        location: null,
        startAt: '2026-04-20T09:00:00.000Z',
        endAt: '2026-04-20T10:00:00.000Z',
        isAllDay: false,
        timezone: 'UTC',
        status: 'confirmed' as const,
        etag: '"etag-fresh-2"',
        updatedAt: '2026-04-20T08:33:00.000Z',
        raw: {}
      }))

      const client = {
        upsertEvent,
        getEvent,
        listCalendars: vi.fn(async () => []),
        createCalendar: vi.fn()
      }

      // #when
      await pushSourceToGoogleCalendar(
        db,
        { sourceType: 'event', sourceId: 'event-second-conflict' },
        { client }
      )

      // #then: the newer remote title wins despite local FC tick-sum being 5
      const refreshedEvent = db
        .select()
        .from(calendarEvents)
        .where(eq(calendarEvents.id, 'event-second-conflict'))
        .get()
      expect(refreshedEvent?.title).toBe('Brand new remote title')
    })
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

  describe('pushSourceToGoogleCalendar — M2 target calendar resolution', () => {
    function buildPushClient() {
      return {
        upsertEvent: vi.fn(
          async ({ calendarId, event }: { calendarId: string; event: { title: string } }) => ({
            id: `remote-${event.title}`,
            calendarId,
            title: event.title,
            description: null,
            location: null,
            startAt: '2026-05-01T09:00:00.000Z',
            endAt: null,
            isAllDay: false,
            timezone: 'UTC',
            status: 'confirmed' as const,
            etag: '"etag-1"',
            updatedAt: '2026-05-01T08:00:00.000Z',
            raw: { summary: event.title }
          })
        ),
        listCalendars: vi.fn(async () => []),
        createCalendar: vi.fn(async () => ({
          id: 'created-memry-cal',
          title: 'Memry',
          timezone: 'UTC',
          color: null,
          isPrimary: false
        }))
      }
    }

    function insertEvent(overrides: Partial<typeof calendarEvents.$inferInsert> = {}) {
      db.insert(calendarEvents)
        .values({
          id: 'event-m2',
          title: 'M2 event',
          startAt: '2026-05-01T09:00:00.000Z',
          endAt: '2026-05-01T10:00:00.000Z',
          timezone: 'UTC',
          isAllDay: false,
          clock: { 'device-a': 1 },
          createdAt: '2026-05-01T08:00:00.000Z',
          modifiedAt: '2026-05-01T08:00:00.000Z',
          ...overrides
        })
        .run()
    }

    function writeCalendarGoogleSetting(
      value: Partial<{
        defaultTargetCalendarId: string | null
        onboardingCompleted: boolean
        promoteConfirmDismissed: boolean
      }>
    ) {
      const merged = {
        defaultTargetCalendarId: null,
        onboardingCompleted: false,
        promoteConfirmDismissed: false,
        ...value
      }
      const now = '2026-05-01T07:00:00.000Z'
      db.insert(settings)
        .values({ key: 'calendar.google', value: JSON.stringify(merged), modifiedAt: now })
        .run()
    }

    it('#given an event with targetCalendarId #when pushed #then writes to that Google calendar (skipping Memry auto-create)', async () => {
      insertEvent({ id: 'event-direct', targetCalendarId: 'work@group.calendar.google.com' })
      const client = buildPushClient()

      await pushSourceToGoogleCalendar(
        db,
        { sourceType: 'event', sourceId: 'event-direct' },
        { client }
      )

      expect(client.upsertEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          calendarId: 'work@group.calendar.google.com',
          eventId: null
        })
      )
      // listCalendars IS invoked to register Work as a selected source
      // so subsequent inbound polls cover it (review fix). createCalendar
      // must stay skipped because this is not the Memry auto-create path.
      expect(client.createCalendar).not.toHaveBeenCalled()
    })

    it('#given no event target but settings default #when pushed #then falls back to the settings default', async () => {
      writeCalendarGoogleSetting({ defaultTargetCalendarId: 'primary@group.calendar.google.com' })
      insertEvent({ id: 'event-settings-default', targetCalendarId: null })
      const client = buildPushClient()

      await pushSourceToGoogleCalendar(
        db,
        { sourceType: 'event', sourceId: 'event-settings-default' },
        { client }
      )

      expect(client.upsertEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          calendarId: 'primary@group.calendar.google.com'
        })
      )
      // createCalendar still skipped — we're using the user's default,
      // not the Memry auto-create fallback. listCalendars may be called
      // once to register the default as a selected source.
      expect(client.createCalendar).not.toHaveBeenCalled()
    })

    it('#given neither event target nor settings default #when pushed #then falls back to Memry-managed calendar', async () => {
      seedGoogleCalendarSource()
      insertEvent({ id: 'event-memry-fallback', targetCalendarId: null })
      const client = buildPushClient()

      await pushSourceToGoogleCalendar(
        db,
        { sourceType: 'event', sourceId: 'event-memry-fallback' },
        { client }
      )

      expect(client.upsertEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          calendarId: 'remote-memry-calendar'
        })
      )
    })

    it('#given an existing binding #when pushed #then keeps using the bound calendar even if targetCalendarId differs (retargeting is out of scope)', async () => {
      seedGoogleCalendarSource()
      insertEvent({
        id: 'event-rebound',
        targetCalendarId: 'work@group.calendar.google.com'
      })
      // Pre-existing binding points at the Memry calendar
      db.insert(calendarBindings)
        .values({
          id: 'binding-rebound',
          sourceType: 'event',
          sourceId: 'event-rebound',
          provider: 'google',
          remoteCalendarId: 'remote-memry-calendar',
          remoteEventId: 'remote-event-rebound',
          ownershipMode: 'memry_managed',
          writebackMode: 'broad',
          remoteVersion: '"etag-prev"',
          lastLocalSnapshot: {},
          clock: { 'device-a': 1 },
          createdAt: '2026-05-01T06:00:00.000Z',
          modifiedAt: '2026-05-01T06:00:00.000Z'
        })
        .run()
      const client = buildPushClient()

      await pushSourceToGoogleCalendar(
        db,
        { sourceType: 'event', sourceId: 'event-rebound' },
        { client }
      )

      expect(client.upsertEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          calendarId: 'remote-memry-calendar',
          eventId: 'remote-event-rebound'
        })
      )
    })

    it('#given a task source (no per-row targetCalendarId concept) #when pushed #then uses settings default if set', async () => {
      writeCalendarGoogleSetting({ defaultTargetCalendarId: 'tasks@group.calendar.google.com' })
      db.insert(tasks)
        .values({
          id: 'task-default-target',
          projectId,
          statusId: todoStatusId,
          title: 'Send invoice',
          position: 1,
          dueDate: '2026-05-02',
          dueTime: null,
          clock: { 'device-a': 1 },
          fieldClocks: {},
          createdAt: '2026-05-01T08:10:00.000Z',
          modifiedAt: '2026-05-01T08:10:00.000Z'
        })
        .run()
      const client = buildPushClient()

      await pushSourceToGoogleCalendar(
        db,
        { sourceType: 'task', sourceId: 'task-default-target' },
        { client }
      )

      expect(client.upsertEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          calendarId: 'tasks@group.calendar.google.com'
        })
      )
    })

    it('#given push resolves to a calendar not yet in calendar_sources #when pushed #then registers the calendar as a selected source so inbound sync can poll it (M2 review fix)', async () => {
      // Simulate the "user picked Work in the picker" flow: the calendar
      // exists on Google but hasn't been registered as a local source yet.
      insertEvent({
        id: 'event-work-pick',
        targetCalendarId: 'work@group.calendar.google.com'
      })
      const client = {
        ...buildPushClient(),
        listCalendars: vi.fn(async () => [
          {
            id: 'primary@example.com',
            title: 'Primary',
            timezone: 'UTC',
            color: null,
            isPrimary: true
          },
          {
            id: 'work@group.calendar.google.com',
            title: 'Work',
            timezone: 'UTC',
            color: '#0b8043',
            isPrimary: false
          }
        ])
      }

      await pushSourceToGoogleCalendar(
        db,
        { sourceType: 'event', sourceId: 'event-work-pick' },
        { client }
      )

      const sources = db.select().from(calendarSources).all()
      const work = sources.find((s) => s.remoteId === 'work@group.calendar.google.com')
      expect(work).toBeDefined()
      expect(work?.kind).toBe('calendar')
      expect(work?.provider).toBe('google')
      expect(work?.isSelected).toBe(true)
      expect(work?.isMemryManaged).toBe(false)
    })

    it('#given the target calendar source already exists but is unselected #when pushed #then flips isSelected to true (M2 review fix)', async () => {
      // Pre-seed Work as an existing but unselected source (e.g. user
      // imported it long ago, then turned it off in Settings).
      const now = '2026-05-01T07:00:00.000Z'
      db.insert(calendarSources)
        .values({
          id: 'google-calendar:work-preseeded',
          provider: 'google',
          kind: 'calendar',
          accountId: 'google-account:1',
          remoteId: 'work@group.calendar.google.com',
          title: 'Work',
          timezone: 'UTC',
          color: null,
          isPrimary: false,
          isSelected: false,
          isMemryManaged: false,
          syncCursor: null,
          syncStatus: 'idle',
          metadata: null,
          clock: { 'device-a': 1 },
          createdAt: now,
          modifiedAt: now
        })
        .run()

      insertEvent({
        id: 'event-work-reselect',
        targetCalendarId: 'work@group.calendar.google.com'
      })

      const client = buildPushClient()
      await pushSourceToGoogleCalendar(
        db,
        { sourceType: 'event', sourceId: 'event-work-reselect' },
        { client }
      )

      const work = db
        .select()
        .from(calendarSources)
        .all()
        .find((s) => s.remoteId === 'work@group.calendar.google.com')
      expect(work?.isSelected).toBe(true)
      // listCalendars must not have been needed since the source existed
      expect(client.listCalendars).not.toHaveBeenCalled()
    })
  })

  describe('single-instance edits for recurring series (M5)', () => {
    it('push: when local event has parentEventId set, emits recurringEventId + originalStartTime to Google', async () => {
      // #given a local exception row — pointing at a Google series we already know
      const seriesGoogleId = 'google-series-1'
      const seriesStart = '2026-05-10T09:00:00.000Z'
      seedGoogleCalendarSource()

      db.insert(calendarEvents)
        .values({
          id: 'event-exception-1',
          title: 'Weekly sync (moved once)',
          startAt: '2026-05-10T10:00:00.000Z',
          endAt: '2026-05-10T11:00:00.000Z',
          timezone: 'UTC',
          isAllDay: false,
          parentEventId: seriesGoogleId,
          originalStartTime: seriesStart,
          clock: { 'device-a': 1 },
          createdAt: '2026-05-09T12:00:00.000Z',
          modifiedAt: '2026-05-10T08:00:00.000Z'
        })
        .run()

      const client = {
        upsertEvent: vi.fn(async ({ calendarId, eventId, event }) => ({
          id: eventId ?? 'google-series-1_20260510T090000Z',
          calendarId,
          title: event.title,
          description: event.description ?? null,
          location: event.location ?? null,
          startAt: event.startAt,
          endAt: event.endAt ?? null,
          isAllDay: event.isAllDay,
          timezone: event.timezone,
          status: 'confirmed' as const,
          etag: '"etag-exception"',
          updatedAt: '2026-05-10T08:01:00.000Z',
          attendees: null,
          reminders: null,
          visibility: null,
          colorId: null,
          conferenceData: null,
          recurringEventId: event.recurringEventId ?? null,
          originalStartTime: event.originalStartTime ?? null,
          raw: { summary: event.title }
        }))
      }

      // #when we push the local exception
      await pushSourceToGoogleCalendar(
        db,
        { sourceType: 'event', sourceId: 'event-exception-1' },
        { client }
      )

      // #then the Google client received recurringEventId + originalStartTime so a child is created
      expect(client.upsertEvent).toHaveBeenCalledTimes(1)
      const call = client.upsertEvent.mock.calls[0][0]
      expect(call.eventId).toBeNull()
      expect(call.event.recurringEventId).toBe(seriesGoogleId)
      expect(call.event.originalStartTime).toBe(seriesStart)
    })

    it('pull: applyGoogleCalendarWriteback populates parentEventId + originalStartTime on the local row', async () => {
      // #given a local event already bound to a Google event
      db.insert(calendarEvents)
        .values({
          id: 'event-exception-pulled',
          title: 'Weekly sync',
          startAt: '2026-05-17T09:00:00.000Z',
          endAt: '2026-05-17T10:00:00.000Z',
          timezone: 'UTC',
          isAllDay: false,
          clock: { 'device-a': 1 },
          createdAt: '2026-05-10T09:00:00.000Z',
          modifiedAt: '2026-05-10T09:00:00.000Z'
        })
        .run()

      // #when Google reports this event as an exception of a recurring series
      await applyGoogleCalendarWriteback(
        db,
        {
          sourceType: 'event',
          sourceId: 'event-exception-pulled',
          writebackMode: 'broad'
        },
        {
          id: 'google-series-2_20260517T090000Z',
          calendarId: 'remote-memry-calendar',
          title: 'Weekly sync (moved)',
          description: null,
          location: null,
          startAt: '2026-05-17T11:00:00.000Z',
          endAt: '2026-05-17T12:00:00.000Z',
          isAllDay: false,
          timezone: 'UTC',
          status: 'confirmed',
          etag: '"etag-pull-exception"',
          updatedAt: '2026-05-17T08:00:00.000Z',
          attendees: null,
          reminders: null,
          visibility: null,
          colorId: null,
          conferenceData: null,
          recurringEventId: 'google-series-2',
          originalStartTime: '2026-05-17T09:00:00.000Z',
          raw: {}
        }
      )

      // #then the local row now carries the exception pointers
      const row = db
        .select()
        .from(calendarEvents)
        .where(eq(calendarEvents.id, 'event-exception-pulled'))
        .get()
      expect(row?.parentEventId).toBe('google-series-2')
      expect(row?.originalStartTime).toBe('2026-05-17T09:00:00.000Z')
    })
  })
})
