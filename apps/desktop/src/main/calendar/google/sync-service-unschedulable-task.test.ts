import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  asClientDb,
  createTestDataDb,
  seedTestData,
  type TestDatabaseResult,
  type TestDb
} from '@tests/utils/test-db'
import { calendarBindings } from '@memry/db-schema/schema/calendar-bindings'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import { tasks } from '@memry/db-schema/schema/tasks'

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

vi.mock('../../lib/logger', () => ({ createLogger: () => loggerMock }))

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: vi.fn(() => []) } }))

vi.mock('./oauth', () => ({
  hasGoogleCalendarLocalAuth: vi.fn(async () => true),
  hasGoogleCalendarConnection: vi.fn(async () => true),
  hasAnyGoogleCalendarLocalAuth: vi.fn(async () => true),
  resolveDefaultGoogleAccountId: vi.fn(() => 'test-account@example.com'),
  listGoogleAccountIds: vi.fn(() => ['test-account@example.com'])
}))

vi.mock('../../sync/auth-state', () => ({
  isMemryUserSignedIn: vi.fn(async () => true)
}))

import { syncLocalSourceToGoogleCalendar } from './sync-service'
import type { GoogleCalendarClient } from '../types'

describe('a task whose schedule cannot become a Google event', () => {
  let dbResult: TestDatabaseResult
  let db: TestDb
  let projectId: string
  let todoStatusId: string

  beforeEach(() => {
    dbResult = createTestDataDb()
    db = dbResult.db
    loggerMock.warn.mockClear()
    const seeded = seedTestData(db)
    projectId = seeded.projectId
    todoStatusId = seeded.statusIds.todo

    const now = '2026-04-12T09:00:00.000Z'
    db.insert(calendarSources)
      .values({
        id: 'google-calendar:memry',
        provider: 'google',
        kind: 'calendar',
        accountId: 'test-account@example.com',
        remoteId: 'remote-memry-calendar',
        title: 'memrynote',
        timezone: 'UTC',
        color: null,
        isPrimary: false,
        isSelected: true,
        isMemryManaged: true,
        syncCursor: null,
        syncStatus: 'idle',
        metadata: null,
        clock: { 'device-a': 1 },
        createdAt: now,
        modifiedAt: now
      })
      .run()
  })

  afterEach(() => {
    dbResult.close()
  })

  function insertTask(id: string, dueDate: string, dueTime: string | null): void {
    db.insert(tasks)
      .values({
        id,
        projectId,
        statusId: todoStatusId,
        title: 'Scheduled task',
        position: 1,
        dueDate,
        dueTime,
        clock: { 'device-a': 1 },
        fieldClocks: {},
        createdAt: '2026-04-12T09:00:00.000Z',
        modifiedAt: '2026-04-12T09:00:00.000Z'
      })
      .run()
  }

  function createClient() {
    const upsertEvent = vi.fn<GoogleCalendarClient['upsertEvent']>(
      async ({ calendarId, eventId, event }) => ({
        id: eventId ?? 'remote-1',
        calendarId,
        title: event.title,
        description: null,
        location: null,
        startAt: event.startAt,
        endAt: event.endAt ?? null,
        isAllDay: event.isAllDay,
        timezone: event.timezone,
        status: 'confirmed' as const,
        etag: '"etag-1"',
        updatedAt: '2026-04-12T10:00:00.000Z',
        attendees: null,
        reminders: null,
        visibility: null,
        colorId: null,
        conferenceData: null,
        recurringEventId: null,
        originalStartTime: null,
        raw: {}
      })
    )
    return {
      upsertEvent,
      deleteEvent: vi.fn<GoogleCalendarClient['deleteEvent']>(async () => {}),
      listCalendars: vi.fn<GoogleCalendarClient['listCalendars']>(async () => []),
      getEvent: vi.fn<GoogleCalendarClient['getEvent']>(),
      createCalendar: vi.fn<GoogleCalendarClient['createCalendar']>()
    }
  }

  it.each([
    ['a day the calendar lacks', '2026-02-30', null],
    ['a year past 9999', '10000-01-01', '09:30'],
    ['an hour past 23', '2026-05-10', '25:00']
  ])(
    '#given %s #when the task changes repeatedly #then Google is never called and one warning is logged',
    async (_label, dueDate, dueTime) => {
      const id = `task-unschedulable-${dueDate}`
      insertTask(id, dueDate, dueTime)
      const client = createClient()

      for (let change = 0; change < 5; change += 1) {
        await expect(
          syncLocalSourceToGoogleCalendar(
            asClientDb(db),
            { sourceType: 'task', sourceId: id },
            { client }
          )
        ).resolves.toBeNull()
      }

      expect(client.upsertEvent).not.toHaveBeenCalled()
      expect(
        db.select().from(calendarBindings).where(eq(calendarBindings.sourceId, id)).all()
      ).toEqual([])
      const warnings = loggerMock.warn.mock.calls.filter(([, context]) => context?.taskId === id)
      expect(warnings).toHaveLength(1)
      expect(warnings[0][1]).toMatchObject({ taskId: id, dueDate, dueTime })
    }
  )

  it('#given a valid timed task #when pushed #then it still reaches Google', async () => {
    insertTask('task-valid-timed', '2026-05-10', '09:30')
    const client = createClient()

    await syncLocalSourceToGoogleCalendar(
      asClientDb(db),
      { sourceType: 'task', sourceId: 'task-valid-timed' },
      { client }
    )

    expect(client.upsertEvent).toHaveBeenCalledTimes(1)
  })
})
