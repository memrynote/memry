/**
 * #1396 hazards 1 and 2, against the Google push path. These are the exact
 * situations an older build hits when another device connects a second
 * writable provider. They are pinned here for #2372: `it.fails` marks what
 * the Google path still gets wrong, and #2372 turns each into a plain `it`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDataDb, seedTestData, type TestDatabaseResult } from '@tests/utils/test-db'
import { calendarBindings } from '@memry/db-schema/schema/calendar-bindings'
import { calendarEvents } from '@memry/db-schema/schema/calendar-events'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import { settings } from '@memry/db-schema/schema/settings'
import { tasks } from '@memry/db-schema/schema/tasks'
import type { DataDb } from '../../database'
import type { GoogleCalendarClient } from '../types'

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: vi.fn(() => []) } }))

vi.mock('./oauth', () => ({
  hasGoogleCalendarLocalAuth: vi.fn(async () => true),
  hasGoogleCalendarConnection: vi.fn(async () => true),
  hasAnyGoogleCalendarLocalAuth: vi.fn(async () => true),
  resolveDefaultGoogleAccountId: vi.fn(() => 'me@example.com'),
  listGoogleAccountIds: vi.fn(() => ['me@example.com'])
}))

vi.mock('../../sync/auth-state', () => ({ isMemryUserSignedIn: vi.fn(async () => true) }))

vi.mock('../../sync/local-mutations', () => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn()
}))

import { syncLocalSourceToGoogleCalendar } from './sync-service'

const NOW = '2026-09-24T08:00:00.000Z'
const CALDAV_COLLECTION = 'https://p67-caldav.icloud.com/1234/calendars/work/'

function pushClient(): Pick<
  GoogleCalendarClient,
  'upsertEvent' | 'deleteEvent' | 'listCalendars' | 'createCalendar' | 'getEvent'
> & { upsertEvent: ReturnType<typeof vi.fn> } {
  return {
    upsertEvent: vi.fn(async ({ calendarId, event }) => ({
      id: 'google-remote-1',
      calendarId,
      title: event.title,
      description: event.description,
      location: event.location,
      startAt: event.startAt,
      endAt: event.endAt,
      isAllDay: event.isAllDay,
      timezone: event.timezone,
      status: 'confirmed' as const,
      etag: '"g1"',
      updatedAt: NOW,
      attendees: null,
      reminders: null,
      visibility: null,
      colorId: null,
      conferenceData: null,
      recurringEventId: null,
      originalStartTime: null,
      raw: {}
    })),
    deleteEvent: vi.fn(async () => {}),
    listCalendars: vi.fn(async () => [
      { id: 'primary@example.com', title: 'Primary', timezone: 'UTC', color: null, isPrimary: true }
    ]),
    createCalendar: vi.fn(),
    getEvent: vi.fn()
  }
}

describe('Google push path with another provider’s rows (#1396 hazards 1-2)', () => {
  let dbResult: TestDatabaseResult
  let db: DataDb
  let projectId: string
  let statusId: string

  beforeEach(() => {
    dbResult = createTestDataDb()
    db = dbResult.db as unknown as DataDb
    const seeded = seedTestData(dbResult.db)
    projectId = seeded.projectId
    statusId = seeded.statusIds.todo
    dbResult.db
      .insert(settings)
      .values({
        key: 'calendar.google',
        value: JSON.stringify({
          defaultTargetCalendarId: 'primary@example.com',
          onboardingCompleted: true,
          promoteConfirmDismissed: false,
          pushEventsToGoogle: true
        }),
        modifiedAt: NOW
      })
      .run()
    dbResult.db
      .insert(calendarSources)
      .values([
        {
          id: 'google-calendar:primary@example.com',
          provider: 'google',
          kind: 'calendar',
          accountId: 'me@example.com',
          remoteId: 'primary@example.com',
          title: 'Primary',
          isSelected: true,
          syncStatus: 'ok',
          createdAt: NOW,
          modifiedAt: NOW
        },
        {
          id: 'caldav-calendar:work',
          provider: 'caldav',
          kind: 'calendar',
          accountId: 'caldav-account',
          remoteId: CALDAV_COLLECTION,
          title: 'Work (iCloud)',
          isSelected: true,
          syncStatus: 'ok',
          createdAt: NOW,
          modifiedAt: NOW
        }
      ])
      .run()
  })

  afterEach(() => {
    dbResult.close()
  })

  it.fails(
    'hazard 1: never pushes a task another provider already holds to Google, even when Google is the default target',
    async () => {
      dbResult.db
        .insert(tasks)
        .values({
          id: 'task-1',
          projectId,
          statusId,
          title: 'Renew passport',
          position: 1,
          dueDate: '2026-09-30',
          clock: { 'device-a': 1 },
          fieldClocks: {},
          createdAt: NOW,
          modifiedAt: NOW
        })
        .run()
      dbResult.db
        .insert(calendarBindings)
        .values({
          id: 'calendar_binding:caldav:task:task-1',
          sourceType: 'task',
          sourceId: 'task-1',
          provider: 'caldav',
          remoteCalendarId: CALDAV_COLLECTION,
          remoteEventId: `${CALDAV_COLLECTION}task-1.ics`,
          ownershipMode: 'memry_managed',
          writebackMode: 'broad',
          remoteVersion: '"c1"',
          clock: { 'device-a': 1 },
          createdAt: NOW,
          modifiedAt: NOW
        })
        .run()
      const client = pushClient()

      await syncLocalSourceToGoogleCalendar(
        db,
        { sourceType: 'task', sourceId: 'task-1' },
        { client }
      )

      expect(client.upsertEvent).not.toHaveBeenCalled()
    }
  )

  it.fails('hazard 2: never sends a CalDAV collection URL to Google as a calendar id', async () => {
    dbResult.db
      .insert(calendarEvents)
      .values({
        id: 'event-1',
        title: 'Dentist',
        startAt: '2026-09-30T09:00:00.000Z',
        endAt: '2026-09-30T10:00:00.000Z',
        timezone: 'UTC',
        isAllDay: false,
        targetCalendarId: CALDAV_COLLECTION,
        clock: { 'device-a': 1 },
        createdAt: NOW,
        modifiedAt: NOW
      })
      .run()
    const client = pushClient()

    await syncLocalSourceToGoogleCalendar(
      db,
      { sourceType: 'event', sourceId: 'event-1' },
      { client }
    )

    expect(client.upsertEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ calendarId: CALDAV_COLLECTION })
    )
  })
})
