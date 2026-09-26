import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { calendarExternalEvents } from '@memry/db-schema/schema/calendar-external-events'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import { syncQueue } from '@memry/db-schema/schema/sync-queue'
import { createTestDataDb, createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'
import type { DataDb, IndexDb } from '../../database'
import type {
  EventKitAuthorizationStatus,
  EventKitBridge,
  EventKitCalendar,
  EventKitEvent
} from './eventkit-types'

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  enqueueCreate: vi.fn(),
  enqueueUpdate: vi.fn(),
  enqueueDelete: vi.fn()
}))

vi.mock('./eventkit-loader', () => ({
  loadEventKitBridge: () => mocks.load(),
  disposeEventKitBridge: vi.fn(async () => undefined)
}))

vi.mock('../../database', () => ({
  isDatabaseInitialized: vi.fn(() => false),
  requireDatabase: vi.fn()
}))

vi.mock('../change-events', () => ({
  emitCalendarChanged: vi.fn(),
  emitCalendarProjectionChanged: vi.fn()
}))

// Every enqueue in the app funnels through these. None may fire (#2374).
vi.mock('../../sync/local-mutations', () => ({
  enqueueLocalSyncCreate: mocks.enqueueCreate,
  enqueueLocalSyncUpdate: mocks.enqueueUpdate,
  enqueueLocalSyncDelete: mocks.enqueueDelete
}))

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

vi.mock('../../telemetry/track', () => ({ trackMainEvent: vi.fn() }))

import { buildProviderStatus } from '../provider/status'
import { getProvider, registerProvider, resetProviderRegistry } from '../provider/registry'
import { upsertSyncedCalendarSource } from '../provider/source-mirrors'
import { getCalendarRangeProjection } from '../projection'
import { ExternalEventReadOnlyError, promoteExternalEvent } from '../promote-external-event'
import { appleEventKitCalendarProvider } from './eventkit-provider'
import {
  APPLE_ACCOUNT_ID,
  EVENTKIT_MAX_PREDICATE_SPAN_MS,
  EVENTKIT_WINDOW_FUTURE_MS,
  EVENTKIT_WINDOW_PAST_MS,
  appleCalendarSourceId,
  toEventKitInstance
} from './eventkit-mirror'
import { tickAppleCalendarRunner, releaseAppleCalendarBridge } from './eventkit-runner'

const NOW = new Date()
const soon = (hours: number): string => new Date(NOW.getTime() + hours * 3600_000).toISOString()

function calendar(id: string, overrides: Partial<EventKitCalendar> = {}): EventKitCalendar {
  return {
    id,
    title: `Calendar ${id}`,
    color: '#1badf8',
    type: 'caldav',
    allowsModifications: true,
    sourceId: 'source-icloud',
    sourceTitle: 'iCloud',
    sourceType: 'caldav',
    ...overrides
  }
}

function event(calendarId: string, overrides: Partial<EventKitEvent> = {}): EventKitEvent {
  return {
    calendarId,
    eventId: 'local-1',
    externalId: 'server-1',
    title: 'Stand-up',
    location: null,
    notes: null,
    url: null,
    isAllDay: false,
    start: soon(24),
    end: soon(25),
    timeZone: 'Europe/Istanbul',
    startDate: null,
    lastDate: null,
    status: 'confirmed',
    availability: 'busy',
    isRecurring: false,
    lastModified: null,
    occurrenceStart: null,
    attendees: [],
    organizer: null,
    alarmMinutes: [],
    recurrenceRule: null,
    ...overrides
  }
}

/** An in-memory EventKit: what Calendar.app has, and what the user answered. */
class FakeEventKit implements EventKitBridge {
  status: EventKitAuthorizationStatus = 'full_access'
  answerOnRequest: EventKitAuthorizationStatus = 'full_access'
  calendars: EventKitCalendar[] = []
  events: EventKitEvent[] = []
  requests = 0
  listEventsCalls: string[][] = []
  private listeners = new Set<() => void>()

  async authorizationStatus(): Promise<EventKitAuthorizationStatus> {
    return this.status
  }
  async requestFullAccess(): Promise<EventKitAuthorizationStatus> {
    this.requests += 1
    if (this.status === 'not_determined') this.status = this.answerOnRequest
    return this.status
  }
  async listCalendars(): Promise<EventKitCalendar[]> {
    return this.calendars
  }
  async listEvents(input: { calendarIds: string[] }): Promise<EventKitEvent[]> {
    this.listEventsCalls.push(input.calendarIds)
    return this.events.filter((item) => input.calendarIds.includes(item.calendarId))
  }
  onChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  dispose(): void {
    this.listeners.clear()
  }
}

describe('macOS Calendar provider (#2374)', () => {
  let dataDb: TestDatabaseResult
  let indexDb: TestDatabaseResult
  let db: DataDb
  let fake: FakeEventKit

  const connect = () => appleEventKitCalendarProvider.connect(db, { provider: 'apple-eventkit' })

  function sources() {
    return db.select().from(calendarSources).all()
  }

  function events() {
    return db.select().from(calendarExternalEvents).all()
  }

  function expectNothingEnqueued(): void {
    expect(mocks.enqueueCreate).not.toHaveBeenCalled()
    expect(mocks.enqueueUpdate).not.toHaveBeenCalled()
    expect(mocks.enqueueDelete).not.toHaveBeenCalled()
    expect(db.select().from(syncQueue).all()).toEqual([])
    for (const row of sources()) expect(row.clock).toBeNull()
    for (const row of events()) expect(row.clock).toBeNull()
  }

  const hostPlatform = process.platform

  beforeEach(() => {
    // Provider status resolves the provider for process.platform, and it only
    // exists on macOS. Pin it so these tests do not depend on the CI host.
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    dataDb = createTestDataDb()
    indexDb = createTestIndexDb()
    db = dataDb.db as unknown as DataDb
    fake = new FakeEventKit()
    fake.calendars = [calendar('home'), calendar('work')]
    fake.events = [event('home'), event('work', { externalId: 'server-2', title: 'Review' })]
    mocks.load.mockResolvedValue({ status: 'available', bridge: fake })
    resetProviderRegistry()
    registerProvider(appleEventKitCalendarProvider)
  })

  afterEach(async () => {
    Object.defineProperty(process, 'platform', { value: hostPlatform })
    await releaseAppleCalendarBridge()
    vi.clearAllMocks()
    dataDb.close()
    indexDb.close()
  })

  describe('platforms', () => {
    it.each(['win32', 'linux'])('does not exist on %s', (platform) => {
      expect(getProvider('apple-eventkit', platform)).toBeNull()
    })

    it('exists on macOS', () => {
      expect(getProvider('apple-eventkit', 'darwin')).toBe(appleEventKitCalendarProvider)
    })
  })

  describe('connect and permission states', () => {
    it('asks once when not determined, then mirrors every calendar without enqueueing anything', async () => {
      fake.status = 'not_determined'

      const result = await connect()

      expect(result.success).toBe(true)
      expect(fake.requests).toBe(1)
      expect(
        sources()
          .map((row) => row.id)
          .sort()
      ).toEqual([
        'apple-eventkit-account:this-mac',
        appleCalendarSourceId('home'),
        appleCalendarSourceId('work')
      ])
      expect(
        events()
          .map((row) => row.title)
          .sort()
      ).toEqual(['Review', 'Stand-up'])
      expect(result.status).toMatchObject({ connected: true, hasLocalAuth: true })
      expect(result.status.accounts[0]).toMatchObject({
        accountId: APPLE_ACCOUNT_ID,
        status: 'connected'
      })
      expectNothingEnqueued()
    })

    it('does not show the dialog when access was already granted', async () => {
      await connect()
      expect(fake.requests).toBe(0)
    })

    it.each([
      ['not_determined', 'denied', 'permission_denied'],
      ['denied', null, 'permission_denied'],
      ['restricted', null, 'permission_restricted'],
      ['write_only', null, 'permission_write_only']
    ] as const)(
      'from %s (answer %s) reports %s and saves nothing',
      async (status, answer, errorCode) => {
        fake.status = status
        if (answer) fake.answerOnRequest = answer

        const result = await connect()

        expect(result).toMatchObject({ success: false, errorCode })
        // The dialog only ever appears for a question never answered.
        expect(fake.requests).toBe(status === 'not_determined' ? 1 : 0)
        expect(sources()).toEqual([])
        expect(events()).toEqual([])
      }
    )

    it('reports unavailable when the helper cannot load, and saves nothing', async () => {
      mocks.load.mockResolvedValue({ status: 'unavailable', reason: 'helper_missing' })
      expect(await connect()).toMatchObject({ success: false, errorCode: 'unavailable' })
      expect(sources()).toEqual([])
    })

    it('purges the mirror, without enqueueing, when access is revoked while running', async () => {
      await connect()
      expect(events()).toHaveLength(2)

      fake.status = 'denied'
      await tickAppleCalendarRunner(db)

      expect(events()).toEqual([])
      // The calendars and the user's choices stay for a re-grant.
      expect(sources()).toHaveLength(3)
      const status = await buildProviderStatus(db, 'apple-eventkit')
      expect(status.hasLocalAuth).toBe(false)
      expect(status.accounts[0]).toMatchObject({
        status: 'reconnect_required',
        reconnectReason: 'rejected',
        lastError: 'permission_denied'
      })
      expectNothingEnqueued()

      fake.status = 'full_access'
      await tickAppleCalendarRunner(db)
      expect(events()).toHaveLength(2)
      expect((await buildProviderStatus(db, 'apple-eventkit')).accounts[0].status).toBe('connected')
    })
  })

  describe('reconcile', () => {
    it('removes a calendar deleted in Calendar.app, with its events, locally', async () => {
      await connect()

      fake.calendars = [calendar('home')]
      fake.events = fake.events.filter((item) => item.calendarId === 'home')
      await appleEventKitCalendarProvider.refresh(db, { provider: 'apple-eventkit' })

      expect(sources().map((row) => row.id)).not.toContain(appleCalendarSourceId('work'))
      expect(events().map((row) => row.sourceId)).toEqual([appleCalendarSourceId('home')])
      expectNothingEnqueued()
    })

    it('drops rows restored from another Mac and adds what this Mac has', async () => {
      await connect()
      fake.calendars = [calendar('other-mac')]
      fake.events = [event('other-mac')]

      await appleEventKitCalendarProvider.refresh(db, { provider: 'apple-eventkit' })

      expect(
        sources()
          .filter((row) => row.kind === 'calendar')
          .map((row) => row.id)
      ).toEqual([appleCalendarSourceId('other-mac')])
    })
  })

  describe('overlap with a directly connected account', () => {
    it('starts a Calendar.app calendar of a connected Google account unchecked, and reads nothing from it', async () => {
      db.insert(calendarSources)
        .values({
          id: 'google-account:me@example.com',
          provider: 'google',
          kind: 'account',
          accountId: 'me@example.com',
          remoteId: 'me@example.com',
          title: 'me@example.com',
          metadata: { email: 'me@example.com' },
          syncStatus: 'ok',
          createdAt: NOW.toISOString(),
          modifiedAt: NOW.toISOString()
        })
        .run()
      fake.calendars = [
        calendar('google-work', { sourceTitle: 'Me@Example.com', sourceType: 'caldav' }),
        calendar('home', { sourceTitle: 'On My Mac', sourceType: 'local' })
      ]
      fake.events = [event('google-work'), event('home', { externalId: 'home-1' })]

      await connect()

      const googleWork = sources().find((row) => row.id === appleCalendarSourceId('google-work'))
      expect(googleWork).toMatchObject({ isSelected: false })
      expect(googleWork?.metadata).toMatchObject({ connectedVia: 'google' })
      expect(sources().find((row) => row.id === appleCalendarSourceId('home'))?.isSelected).toBe(
        true
      )
      expect(fake.listEventsCalls.flat()).not.toContain('google-work')
      expect(events().map((row) => row.sourceId)).toEqual([appleCalendarSourceId('home')])
    })

    it('keeps the user override on later passes', async () => {
      await connect()
      const row = sources().find((item) => item.id === appleCalendarSourceId('home'))!
      const hidden = upsertSyncedCalendarSource(db, { ...row, isSelected: false })
      appleEventKitCalendarProvider.onSelectionChanged(db, row, { ...row, isSelected: false })

      await appleEventKitCalendarProvider.refresh(db, { provider: 'apple-eventkit' })

      expect(hidden.isSelected).toBe(false)
      expect(sources().find((item) => item.id === row.id)?.isSelected).toBe(false)
      expect(events().map((item) => item.sourceId)).toEqual([appleCalendarSourceId('work')])
      expectNothingEnqueued()
    })
  })

  describe('events', () => {
    it('updates changed events and deletes ones Calendar.app no longer has', async () => {
      await connect()
      fake.events = [event('home', { title: 'Stand-up (moved room)', location: 'Room 4' })]

      await appleEventKitCalendarProvider.refresh(db, { provider: 'apple-eventkit' })

      expect(events()).toHaveLength(1)
      expect(events()[0]).toMatchObject({ title: 'Stand-up (moved room)', location: 'Room 4' })
    })

    it('stores attendees, alerts, the series rule and the join link, and fills in rows mirrored before they existed', async () => {
      await connect()
      expect(events().find((row) => row.title === 'Stand-up')?.attendees).toBeNull()

      fake.events = [
        event('home', {
          attendees: [
            {
              name: null,
              email: 'me@example.com',
              status: 'accepted',
              role: 'required',
              type: 'person',
              isCurrentUser: true
            }
          ],
          alarmMinutes: [10],
          recurrenceRule: 'FREQ=WEEKLY;BYDAY=TU',
          notes: 'Join with Google Meet: https://meet.google.com/abc-defg-hij'
        }),
        event('work', { externalId: 'server-2', title: 'Review' })
      ]
      await appleEventKitCalendarProvider.refresh(db, { provider: 'apple-eventkit' })

      const standUp = events().find((row) => row.title === 'Stand-up')
      expect(standUp).toMatchObject({
        attendees: [expect.objectContaining({ email: 'me@example.com', self: true })],
        reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] },
        recurrenceRule: { rrule: 'FREQ=WEEKLY;BYDAY=TU' },
        conferenceData: expect.objectContaining({
          entryPoints: [expect.objectContaining({ uri: 'https://meet.google.com/abc-defg-hij' })]
        })
      })
      expectNothingEnqueued()
    })

    it('keys rows by the external identifier and occurrence start, recording which id was used', () => {
      const withExternal = toEventKitInstance(
        event('home', { isRecurring: true, occurrenceStart: '2026-05-04T06:00:00.000Z' })
      )
      expect(withExternal?.remoteEventId).toBe('server-1::2026-05-04T06:00:00.000Z')
      expect(withExternal?.rawPayload).toMatchObject({ idKind: 'external' })

      const localOnly = toEventKitInstance(event('home', { externalId: null }))
      expect(localOnly?.remoteEventId.startsWith('local-1::')).toBe(true)
      expect(localOnly?.rawPayload).toMatchObject({ idKind: 'event' })
    })

    it('stores all-day events as dates, drops cancelled ones, and maps tentative', () => {
      expect(
        toEventKitInstance(
          event('home', {
            isAllDay: true,
            start: null,
            end: null,
            timeZone: null,
            startDate: '2026-05-04',
            lastDate: '2026-05-05'
          })
        )
      ).toMatchObject({
        startAt: '2026-05-04T00:00:00.000Z',
        endAt: '2026-05-06T00:00:00.000Z',
        timezone: null,
        isAllDay: true
      })
      expect(toEventKitInstance(event('home', { status: 'canceled' }))).toBeNull()
      expect(toEventKitInstance(event('home', { status: 'tentative' }))?.status).toBe('tentative')
      // Busy/free is not privacy: it stays out of `visibility`.
      expect(toEventKitInstance(event('home', { availability: 'free' }))?.rawPayload).toMatchObject(
        { availability: 'free' }
      )
    })

    it('reads a window EventKit will not silently truncate', () => {
      expect(EVENTKIT_WINDOW_PAST_MS + EVENTKIT_WINDOW_FUTURE_MS).toBeLessThan(
        EVENTKIT_MAX_PREDICATE_SPAN_MS
      )
    })
  })

  describe('read-only', () => {
    it('shows events as not editable and refuses promotion', async () => {
      await connect()
      const projection = getCalendarRangeProjection(
        db,
        indexDb.db as unknown as IndexDb,
        { startAt: soon(-48), endAt: soon(72), includeUnselectedSources: false },
        []
      )
      const item = projection.items.find((entry) => entry.sourceType === 'external_event')
      expect(item?.editability).toEqual({
        canMove: false,
        canResize: false,
        canEditText: false,
        canDelete: false
      })
      expect(() => promoteExternalEvent(db, { externalEventId: events()[0].id })).toThrow(
        ExternalEventReadOnlyError
      )
      expectNothingEnqueued()
    })
  })

  describe('disconnect', () => {
    it('removes every row locally and enqueues nothing', async () => {
      await connect()
      await appleEventKitCalendarProvider.disconnect(db, { provider: 'apple-eventkit' })

      expect(sources()).toEqual([])
      expect(events()).toEqual([])
      expect((await buildProviderStatus(db, 'apple-eventkit')).connected).toBe(false)
      expectNothingEnqueued()
    })

    it('leaves nothing behind when a pass is still running at disconnect', async () => {
      await connect()
      let release: () => void = () => undefined
      const slow = new Promise<void>((resolve) => {
        release = resolve
      })
      const listCalendars = fake.listCalendars.bind(fake)
      fake.listCalendars = async () => {
        await slow
        return listCalendars()
      }

      const refreshing = appleEventKitCalendarProvider.refresh(db, { provider: 'apple-eventkit' })
      const disconnecting = appleEventKitCalendarProvider.disconnect(db, {
        provider: 'apple-eventkit'
      })
      release()
      await Promise.all([refreshing, disconnecting])

      expect(sources()).toEqual([])
      expect(events()).toEqual([])
      expectNothingEnqueued()
    })

    it('never touches the helper again once disconnected', async () => {
      await connect()
      await appleEventKitCalendarProvider.disconnect(db, { provider: 'apple-eventkit' })
      mocks.load.mockClear()

      await tickAppleCalendarRunner(db)

      expect(mocks.load).not.toHaveBeenCalled()
      expect(
        db
          .select()
          .from(calendarSources)
          .where(eq(calendarSources.provider, 'apple-eventkit'))
          .all()
      ).toEqual([])
    })
  })
})
