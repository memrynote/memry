import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { calendarBindings } from '@memry/db-schema/schema/calendar-bindings'
import { calendarEvents } from '@memry/db-schema/schema/calendar-events'
import { calendarExternalEvents } from '@memry/db-schema/schema/calendar-external-events'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import {
  asClientDb,
  createTestDataDb,
  type TestDatabaseResult,
  type TestDb
} from '@tests/utils/test-db'
import type { CalendarProviderCapabilities } from '@memry/contracts/calendar-api'

const { mockCalendarSend } = vi.hoisted(() => ({ mockCalendarSend: vi.fn() }))

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => [
      {
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send: mockCalendarSend }
      }
    ])
  }
}))

vi.mock('../../sync/auth-state', () => ({
  isMemryUserSignedIn: vi.fn(async () => true)
}))

vi.mock('../../sync/local-mutations', () => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn()
}))

import type { CalendarProviderAdapter, RemoteCalendarEvent } from '../provider/adapter'
import { ProviderGoneError } from '../provider/errors'
import {
  __resetSyncInFlightForTests,
  pushSourceToProvider,
  syncLocalSourceToProvider,
  syncProviderNow,
  syncProviderSource,
  type ProviderSyncContext
} from './engine'

const WRITE_CAPABILITIES: CalendarProviderCapabilities = {
  supportsWrite: true,
  supportsCreateCalendar: true,
  supportsPush: false,
  supportsMultiAccount: false,
  incrementalMode: 'sync-token',
  authFlow: 'oauth2'
}

const READ_ONLY_CAPABILITIES: CalendarProviderCapabilities = {
  supportsWrite: false,
  supportsCreateCalendar: false,
  supportsPush: false,
  supportsMultiAccount: false,
  incrementalMode: 'conditional-get',
  authFlow: 'url'
}

function remoteEvent(overrides: Partial<RemoteCalendarEvent> = {}): RemoteCalendarEvent {
  return {
    id: 'remote-event-1',
    calendarId: 'remote-cal',
    title: 'Standup',
    description: null,
    location: null,
    startAt: '2026-04-14T09:00:00.000Z',
    endAt: '2026-04-14T09:15:00.000Z',
    isAllDay: false,
    timezone: 'UTC',
    status: 'confirmed',
    etag: 'etag-1',
    updatedAt: '2026-04-13T09:00:00.000Z',
    attendees: null,
    reminders: null,
    visibility: null,
    colorId: null,
    conferenceData: null,
    recurringEventId: null,
    originalStartTime: null,
    raw: {},
    ...overrides
  }
}

interface FakeAdapterOptions {
  listEvents?: CalendarProviderAdapter['listEvents']
  supportsWrite?: boolean
}

function createFakeAdapter(options: FakeAdapterOptions = {}): CalendarProviderAdapter {
  const base: CalendarProviderAdapter = {
    listCalendars: vi.fn(async () => [
      { id: 'remote-cal', title: 'Work', timezone: 'UTC', color: null, isPrimary: true }
    ]),
    listEvents:
      options.listEvents ?? vi.fn(async () => ({ events: [], nextSyncCursor: 'cursor-2' })),
    getEvent: vi.fn(async () => remoteEvent())
  }

  if (options.supportsWrite === false) return base

  return {
    ...base,
    // A distinct id from the listed calendar, as every real provider returns.
    createCalendar: vi.fn(async () => ({
      id: 'remote-memry',
      title: 'memrynote',
      timezone: 'UTC',
      color: null,
      isPrimary: false
    })),
    upsertEvent: vi.fn(async () => remoteEvent()),
    deleteEvent: vi.fn(async () => {})
  }
}

function createContext(
  providerId: string,
  capabilities: CalendarProviderCapabilities,
  adapter: CalendarProviderAdapter
): ProviderSyncContext {
  return {
    providerId,
    capabilities,
    createAdapter: () => adapter,
    listAccountIds: () => ['account-1'],
    resolveDefaultAccountId: () => 'account-1',
    hasConnection: async () => true,
    isPushEnabled: () => true,
    resolveTargetAccountId: () => 'account-1',
    readDefaultTargetCalendarId: () => 'remote-cal'
  }
}

describe('calendar sync engine (provider-neutral)', () => {
  let dbResult: TestDatabaseResult
  let db: TestDb

  beforeEach(() => {
    __resetSyncInFlightForTests()
    dbResult = createTestDataDb()
    db = dbResult.db
    mockCalendarSend.mockClear()
  })

  afterEach(() => {
    dbResult.close()
  })

  function seedSource(overrides: Partial<typeof calendarSources.$inferInsert> = {}): void {
    const now = '2026-04-12T09:00:00.000Z'
    db.insert(calendarSources)
      .values({
        id: 'p-calendar:remote-cal',
        provider: 'p',
        kind: 'calendar',
        accountId: 'account-1',
        remoteId: 'remote-cal',
        title: 'Work',
        timezone: 'UTC',
        color: null,
        isPrimary: true,
        isSelected: true,
        isMemryManaged: false,
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

  function seedEvent(id = 'event-1'): void {
    db.insert(calendarEvents)
      .values({
        id,
        title: 'Team Sync',
        startAt: '2026-04-14T09:00:00.000Z',
        endAt: '2026-04-14T10:00:00.000Z',
        timezone: 'UTC',
        isAllDay: false,
        clock: { 'device-a': 1 },
        createdAt: '2026-04-12T09:10:00.000Z',
        modifiedAt: '2026-04-12T09:10:00.000Z'
      })
      .run()
  }

  describe('two providers are independent', () => {
    let slowAdapterListEvents: ReturnType<typeof vi.fn>
    let slowAdapter: CalendarProviderAdapter
    let fastAdapter: CalendarProviderAdapter

    beforeEach(() => {
      slowAdapterListEvents = vi.fn(async () => ({ events: [], nextSyncCursor: 'c' }))
      slowAdapter = createFakeAdapter({
        listEvents: slowAdapterListEvents as unknown as CalendarProviderAdapter['listEvents']
      })
      fastAdapter = createFakeAdapter()
    })

    it('syncs concurrently — a slow provider does not block a fast one', async () => {
      let releaseSlow: () => void = () => {}
      const slowStarted = new Promise<void>((entered) => {
        slowAdapterListEvents.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              releaseSlow = () => resolve({ events: [], nextSyncCursor: 'slow-cursor' })
              entered()
            })
        )
      })

      const slowContext = createContext('slow', WRITE_CAPABILITIES, slowAdapter)
      const fastContext = createContext('fast', WRITE_CAPABILITIES, fastAdapter)

      seedSource({ id: 'slow-calendar:remote-cal', provider: 'slow' })
      seedSource({ id: 'fast-calendar:remote-cal', provider: 'fast' })

      const slowRun = syncProviderNow(asClientDb(db), slowContext)
      await slowStarted

      // #when the fast provider syncs while the slow one is still parked
      await syncProviderNow(asClientDb(db), fastContext)

      // #then it finished on its own, without waiting for the slow provider
      expect(
        db
          .select()
          .from(calendarSources)
          .all()
          .find((row) => row.provider === 'fast')?.syncStatus
      ).toBe('ok')

      releaseSlow()
      await slowRun
    })

    it('refuses a second concurrent sweep of the SAME provider', async () => {
      let releaseFirst: () => void = () => {}
      const firstStarted = new Promise<void>((entered) => {
        slowAdapterListEvents.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              releaseFirst = () => resolve({ events: [], nextSyncCursor: 'c' })
              entered()
            })
        )
      })
      const context = createContext('slow', WRITE_CAPABILITIES, slowAdapter)
      seedSource({ id: 'slow-calendar:remote-cal', provider: 'slow' })

      const first = syncProviderNow(asClientDb(db), context)
      await firstStarted
      await syncProviderNow(asClientDb(db), context)

      // The re-entrant call returned immediately without a second listEvents.
      expect(slowAdapterListEvents).toHaveBeenCalledTimes(1)

      releaseFirst()
      await first
    })
  })

  describe('a read-only provider can never write a binding', () => {
    it('refuses a direct push', async () => {
      const adapter = createFakeAdapter({ supportsWrite: false })
      const context = createContext('ics', READ_ONLY_CAPABILITIES, adapter)
      seedEvent()

      await expect(
        pushSourceToProvider(asClientDb(db), context, {
          sourceType: 'event',
          sourceId: 'event-1'
        })
      ).rejects.toThrow(/read-only/)

      expect(db.select().from(calendarBindings).all()).toHaveLength(0)
    })

    it('returns null from the local-change path instead of pushing', async () => {
      const adapter = createFakeAdapter({ supportsWrite: false })
      const context = createContext('ics', READ_ONLY_CAPABILITIES, adapter)
      seedEvent()

      const result = await syncLocalSourceToProvider(asClientDb(db), context, {
        sourceType: 'event',
        sourceId: 'event-1'
      })

      expect(result).toBeNull()
      expect(db.select().from(calendarBindings).all()).toHaveLength(0)
    })

    it('mirrors inbound events as external events and writes no binding', async () => {
      const adapter = createFakeAdapter({
        supportsWrite: false,
        listEvents: vi.fn(async () => ({
          events: [remoteEvent()],
          nextSyncCursor: null
        })) as unknown as CalendarProviderAdapter['listEvents']
      })
      const context = createContext('ics', READ_ONLY_CAPABILITIES, adapter)
      seedSource({ id: 'ics-calendar:remote-cal', provider: 'ics' })

      await syncProviderSource(asClientDb(db), context, 'ics-calendar:remote-cal')

      expect(db.select().from(calendarExternalEvents).all()).toHaveLength(1)
      expect(db.select().from(calendarBindings).all()).toHaveLength(0)
    })

    it('never provisions a memrynote calendar for a read-only provider', async () => {
      const adapter = createFakeAdapter({ supportsWrite: false })
      const context = createContext('ics', READ_ONLY_CAPABILITIES, adapter)

      await syncProviderNow(asClientDb(db), context)

      expect(
        db
          .select()
          .from(calendarSources)
          .all()
          .some((row) => row.isMemryManaged)
      ).toBe(false)
    })
  })

  describe('cursor handling follows incrementalMode', () => {
    it('ProviderGoneError clears the cursor and re-runs the source from scratch', async () => {
      const listEvents = vi
        .fn()
        .mockRejectedValueOnce(new ProviderGoneError('sync token expired'))
        .mockResolvedValueOnce({ events: [remoteEvent()], nextSyncCursor: 'fresh-cursor' })
      const adapter = createFakeAdapter({
        listEvents: listEvents as unknown as CalendarProviderAdapter['listEvents']
      })
      const context = createContext('p', WRITE_CAPABILITIES, adapter)
      seedSource({ syncCursor: 'stale-cursor' })

      await syncProviderSource(asClientDb(db), context, 'p-calendar:remote-cal')

      // #then the retry ran with no cursor at all, and the fresh one was stored
      expect(listEvents).toHaveBeenCalledTimes(2)
      expect(listEvents.mock.calls[0]?.[0]).toMatchObject({ syncCursor: 'stale-cursor' })
      expect(listEvents.mock.calls[1]?.[0]).toMatchObject({ syncCursor: null })
      const source = db.select().from(calendarSources).all()[0]
      expect(source?.syncCursor).toBe('fresh-cursor')
      expect(source?.syncStatus).toBe('ok')
    })

    it('a missing cursor resets a sync-token provider', async () => {
      const listEvents = vi
        .fn()
        .mockResolvedValueOnce({ events: [], nextSyncCursor: null })
        .mockResolvedValueOnce({ events: [], nextSyncCursor: 'fresh-cursor' })
      const adapter = createFakeAdapter({
        listEvents: listEvents as unknown as CalendarProviderAdapter['listEvents']
      })
      const context = createContext('p', WRITE_CAPABILITIES, adapter)
      seedSource({ syncCursor: 'stale-cursor' })

      await syncProviderSource(asClientDb(db), context, 'p-calendar:remote-cal')

      expect(listEvents).toHaveBeenCalledTimes(2)
    })

    it('a missing cursor is normal for a conditional-get provider and triggers no reset', async () => {
      const listEvents = vi.fn().mockResolvedValue({ events: [], nextSyncCursor: null })
      const adapter = createFakeAdapter({
        supportsWrite: false,
        listEvents: listEvents as unknown as CalendarProviderAdapter['listEvents']
      })
      const context = createContext('ics', READ_ONLY_CAPABILITIES, adapter)
      seedSource({ id: 'ics-calendar:remote-cal', provider: 'ics', syncCursor: 'etag-abc' })

      await syncProviderSource(asClientDb(db), context, 'ics-calendar:remote-cal')

      // A feed provider has no cursor to lose — one pass, no infinite re-read.
      expect(listEvents).toHaveBeenCalledTimes(1)
    })
  })
})
