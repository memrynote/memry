import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { sql } from 'drizzle-orm'
import { invokeHandler, mockIpcMain, resetIpcMocks } from '@tests/utils/mock-ipc'
import {
  asClientDb,
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult,
  type TestDb
} from '@tests/utils/test-db'
import { CalendarChannels } from '@memry/contracts/ipc-channels'
import type {
  CalendarProviderMutationResponse,
  CalendarProviderStatus,
  IcsCalendarMutationResponse,
  ListCalendarProvidersResponse,
  ListProviderCalendarsResponse,
  RetryCalendarSourceSyncResponse
} from '@memry/contracts/calendar-api'

const mocks = vi.hoisted(() => ({
  syncGoogleCalendarSource: vi.fn(),
  listGoogleCalendars: vi.fn(),
  setDefaultGoogleCalendar: vi.fn(),
  resolveDefaultGoogleAccountId: vi.fn((..._args: unknown[]) => null as string | null)
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: unknown) =>
      mockIpcMain.handle(channel, handler as Parameters<typeof mockIpcMain.handle>[1])
    ),
    removeHandler: vi.fn((channel: string) => mockIpcMain.removeHandler(channel))
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) }
}))

vi.mock('../database', () => ({
  getDatabase: vi.fn(),
  requireDatabase: vi.fn(),
  getIndexDatabase: vi.fn()
}))

vi.mock('../sync/local-mutations', () => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn()
}))

vi.mock('../calendar/google/oauth', () => ({
  connectGoogleCalendar: vi.fn(),
  disconnectGoogleCalendar: vi.fn(),
  hasGoogleCalendarLocalAuth: vi.fn(async () => false),
  hasAnyGoogleCalendarLocalAuth: vi.fn(async () => false),
  listGoogleAccountIds: vi.fn(() => []),
  resolveDefaultGoogleAccountId: (...args: unknown[]) =>
    mocks.resolveDefaultGoogleAccountId(...args)
}))

vi.mock('../calendar/google/sync-service', () => ({
  discoverGoogleCalendarSources: vi.fn(),
  syncGoogleCalendarNow: vi.fn(),
  syncGoogleCalendarSource: (...args: unknown[]) => mocks.syncGoogleCalendarSource(...args),
  syncLocalSourceToGoogleCalendar: vi.fn(async () => null),
  startGoogleCalendarSyncRunner: vi.fn(async () => {}),
  stopGoogleCalendarSyncRunner: vi.fn()
}))

vi.mock('../calendar/google/onboarding', () => ({
  listGoogleCalendars: (...args: unknown[]) => mocks.listGoogleCalendars(...args),
  setDefaultGoogleCalendar: (...args: unknown[]) => mocks.setDefaultGoogleCalendar(...args)
}))

vi.mock('../calendar/google/client', () => ({
  createGoogleCalendarClient: vi.fn((options: unknown) => ({ options }))
}))

vi.mock('../calendar/google/push-runtime', () => ({
  getGooglePushRuntime: vi.fn(() => null)
}))

vi.mock('../auth-state', () => ({ isMemryUserSignedIn: vi.fn(async () => true) }))

import { getDatabase, getIndexDatabase, requireDatabase } from '../database'
import { enqueueLocalSyncDelete } from '../sync/local-mutations'
import { registerCalendarHandlers, unregisterCalendarHandlers } from './calendar-handlers'
import {
  getProvider,
  listProviders,
  registerProvider,
  resetProviderRegistry,
  type ProviderDefinition
} from '../calendar/provider/registry'
import { registerBuiltinCalendarProviders } from '../calendar/provider/builtin-providers'
import { PROVIDER_CAPABILITIES } from '../calendar/provider/capabilities'

const FEED_URL = 'https://club.example.com/fixtures.ics'
const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000)
  .toISOString()
  .replace(/[-:]/g, '')
  .replace(/\.\d{3}/, '')
const FEED = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Test//EN',
  'X-WR-CALNAME:Club fixtures',
  'BEGIN:VEVENT',
  'UID:match-1@club',
  `DTSTART:${tomorrow}`,
  'SUMMARY:Home match',
  'END:VEVENT',
  'END:VCALENDAR'
].join('\r\n')

function stubFeed(...responses: Array<() => Response>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const next = responses.shift()
      if (!next) throw new TypeError('fetch failed')
      return next()
    })
  )
}

function seedGoogleCalendar(db: TestDb): void {
  db.run(sql`
    INSERT INTO calendar_sources (
      id, provider, kind, account_id, remote_id, title, timezone,
      is_selected, sync_status, created_at, modified_at
    ) VALUES (
      ${'google-calendar:edge'}, ${'google'}, ${'calendar'},
      ${'edge@example.com'}, ${'edge-calendar'}, ${'Edge Calendar'}, ${'UTC'},
      ${1}, ${'ok'}, ${'2026-09-24T08:00:00.000Z'}, ${'2026-09-24T08:00:00.000Z'}
    )
  `)
}

describe('calendar provider registry and generic channels (#1392)', () => {
  let dbResult: TestDatabaseResult
  let indexDbResult: TestDatabaseResult

  beforeEach(() => {
    resetIpcMocks()
    vi.clearAllMocks()
    dbResult = createTestDataDb()
    indexDbResult = createTestIndexDb()
    ;(getDatabase as Mock).mockReturnValue(asClientDb(dbResult.db))
    ;(requireDatabase as Mock).mockReturnValue(asClientDb(dbResult.db))
    ;(getIndexDatabase as Mock).mockReturnValue(asClientDb(indexDbResult.db))
    mocks.resolveDefaultGoogleAccountId.mockReturnValue(null)
    mocks.syncGoogleCalendarSource.mockResolvedValue(undefined)
    registerCalendarHandlers()
  })

  afterEach(() => {
    unregisterCalendarHandlers()
    vi.unstubAllGlobals()
    dbResult.close()
    indexDbResult.close()
  })

  describe('registry', () => {
    afterEach(() => {
      resetProviderRegistry()
      registerBuiltinCalendarProviders()
    })

    it('registers Google and ICS with their declared capabilities', () => {
      expect(listProviders().map((definition) => definition.id)).toEqual(['google', 'ics'])
      expect(getProvider('google')?.capabilities).toBe(PROVIDER_CAPABILITIES.google)
      expect(getProvider('ics')?.capabilities).toBe(PROVIDER_CAPABILITIES.ics)
      expect(getProvider('microsoft')).toBeNull()
    })

    it('hides a provider whose platforms exclude this OS, as if it did not exist', () => {
      const macOnly: ProviderDefinition = {
        ...(getProvider('ics') as ProviderDefinition),
        id: 'macos-only',
        capabilities: { ...PROVIDER_CAPABILITIES.ics, platforms: ['darwin'] }
      }
      registerProvider(macOnly)
      expect(getProvider('macos-only', 'darwin')?.id).toBe('macos-only')
      expect(getProvider('macos-only', 'win32')).toBeNull()
      expect(listProviders('linux').map((definition) => definition.id)).not.toContain('macos-only')
      expect(listProviders('darwin').map((definition) => definition.id)).toContain('macos-only')
    })
  })

  it('lists the providers with their capabilities for the settings UI', async () => {
    const response = await invokeHandler<ListCalendarProvidersResponse>(
      CalendarChannels.invoke.LIST_PROVIDERS
    )
    expect(response.providers).toEqual([
      { id: 'google', capabilities: PROVIDER_CAPABILITIES.google },
      { id: 'ics', capabilities: PROVIDER_CAPABILITIES.ics }
    ])
  })

  it('returns the byte-identical unsupported-provider error on connect, disconnect and refresh', async () => {
    for (const channel of [
      CalendarChannels.invoke.CONNECT_PROVIDER,
      CalendarChannels.invoke.DISCONNECT_PROVIDER,
      CalendarChannels.invoke.REFRESH_PROVIDER
    ]) {
      const response = await invokeHandler<CalendarProviderMutationResponse>(channel, {
        provider: 'outlook'
      })
      expect(response.success).toBe(false)
      expect(response.error).toBe('Unsupported calendar provider: outlook')
      expect(response.status).toEqual({
        provider: 'outlook',
        connected: false,
        hasLocalAuth: false,
        account: null,
        accounts: [],
        calendars: { total: 0, selected: 0, memryManaged: 0 },
        lastSyncedAt: null
      })
    }
  })

  it('attaches capabilities to the status only when asked', async () => {
    const plain = await invokeHandler<CalendarProviderStatus>(
      CalendarChannels.invoke.GET_PROVIDER_STATUS,
      { provider: 'google' }
    )
    expect(plain).not.toHaveProperty('capabilities')
    const withCapabilities = await invokeHandler<CalendarProviderStatus>(
      CalendarChannels.invoke.GET_PROVIDER_STATUS,
      { provider: 'google', includeCapabilities: true }
    )
    expect(withCapabilities.capabilities).toEqual(PROVIDER_CAPABILITIES.google)
  })

  // #1396 hazard 3: an older build lists a source from a provider it does not
  // know. Unticking it purges the mirror and enqueues the deletes, so a synced
  // mirror disappears on every device until the provider's next pull. That is
  // how new builds treat unselecting too; this pins it for unknown providers.
  it('unticking a source from a provider this build does not know purges and syncs its mirror', async () => {
    for (const provider of ['caldav', 'microsoft']) {
      dbResult.db.run(sql`
        INSERT INTO calendar_sources (
          id, provider, kind, remote_id, title, is_selected, sync_status, created_at, modified_at
        ) VALUES (
          ${`${provider}-src`}, ${provider}, ${'calendar'}, ${`${provider}-remote`}, ${'Work'},
          ${1}, ${'ok'}, ${'2026-09-24T08:00:00.000Z'}, ${'2026-09-24T08:00:00.000Z'}
        )
      `)
      dbResult.db.run(sql`
        INSERT INTO calendar_external_events (
          id, source_id, remote_event_id, title, start_at, is_all_day, status, created_at, modified_at
        ) VALUES (
          ${`${provider}-evt`}, ${`${provider}-src`}, ${'remote-evt'}, ${'Standup'},
          ${'2026-09-25T09:00:00.000Z'}, ${0}, ${'confirmed'},
          ${'2026-09-24T08:00:00.000Z'}, ${'2026-09-24T08:00:00.000Z'}
        )
      `)
    }

    const response = await invokeHandler(CalendarChannels.invoke.UPDATE_SOURCE_SELECTION, {
      id: 'microsoft-src',
      isSelected: false
    })

    expect(response).toMatchObject({ success: true, source: { isSelected: false } })
    const remaining = dbResult.db.all<{ id: string }>(sql`SELECT id FROM calendar_external_events`)
    expect(remaining.map((row) => row.id)).toEqual(['caldav-evt'])
    expect(vi.mocked(enqueueLocalSyncDelete)).toHaveBeenCalledWith(
      'calendar_external_event',
      'microsoft-evt',
      expect.any(String)
    )
  })

  describe('ICS through the generic channels and the legacy aliases', () => {
    function mirroredEventCount(): number {
      return dbResult.db.all<{ count: number }>(
        sql`SELECT count(*) AS count FROM calendar_external_events`
      )[0].count
    }

    it('connect-provider with a url connection subscribes exactly like subscribe-ics', async () => {
      stubFeed(() => new Response(FEED, { status: 200 }))
      const generic = await invokeHandler<CalendarProviderMutationResponse>(
        CalendarChannels.invoke.CONNECT_PROVIDER,
        {
          provider: 'ics',
          connection: { kind: 'url', url: 'webcal://club.example.com/fixtures.ics' }
        }
      )
      expect(generic).toMatchObject({
        success: true,
        source: { provider: 'ics', remoteId: FEED_URL, title: 'Club fixtures' }
      })
      expect(mirroredEventCount()).toBe(1)

      // The legacy alias converges on the same row: subscribing again is a no-op.
      const legacy = await invokeHandler<IcsCalendarMutationResponse>(
        CalendarChannels.invoke.SUBSCRIBE_ICS_CALENDAR,
        { url: FEED_URL }
      )
      expect(legacy).toEqual({ success: true, source: generic.source })
    })

    it('reports the same localizable code as subscribe-ics for a bad link', async () => {
      const legacy = await invokeHandler<IcsCalendarMutationResponse>(
        CalendarChannels.invoke.SUBSCRIBE_ICS_CALENDAR,
        { url: 'club fixtures' }
      )
      const generic = await invokeHandler<CalendarProviderMutationResponse>(
        CalendarChannels.invoke.CONNECT_PROVIDER,
        { provider: 'ics', connection: { kind: 'url', url: 'club fixtures' } }
      )
      expect(legacy).toEqual({
        success: false,
        source: null,
        errorCode: 'invalid_url',
        error: 'invalid_url'
      })
      expect(generic).toMatchObject({
        success: false,
        errorCode: legacy.errorCode,
        error: legacy.error,
        source: null
      })
    })

    it('refresh-provider and refresh-ics record the same failure on the source', async () => {
      stubFeed(
        () => new Response(FEED, { status: 200 }),
        () => new Response('', { status: 404 }),
        () => new Response('', { status: 404 })
      )
      const subscribed = await invokeHandler<IcsCalendarMutationResponse>(
        CalendarChannels.invoke.SUBSCRIBE_ICS_CALENDAR,
        { url: FEED_URL }
      )
      const sourceId = subscribed.source!.id

      const legacy = await invokeHandler<IcsCalendarMutationResponse>(
        CalendarChannels.invoke.REFRESH_ICS_CALENDAR,
        { sourceId }
      )
      const generic = await invokeHandler<CalendarProviderMutationResponse>(
        CalendarChannels.invoke.REFRESH_PROVIDER,
        { provider: 'ics', sourceId }
      )
      expect(legacy).toMatchObject({
        success: false,
        errorCode: 'not_found',
        source: { id: sourceId, syncStatus: 'error', lastError: 'not_found' }
      })
      expect(generic).toMatchObject({
        success: false,
        errorCode: legacy.errorCode,
        error: legacy.error,
        source: { id: sourceId, syncStatus: 'error', lastError: 'not_found' }
      })
    })

    it('disconnect-provider with a sourceId unsubscribes like unsubscribe-ics', async () => {
      stubFeed(
        () => new Response(FEED, { status: 200 }),
        () => new Response(FEED.replace('club', 'league'), { status: 200 })
      )
      const first = await invokeHandler<IcsCalendarMutationResponse>(
        CalendarChannels.invoke.SUBSCRIBE_ICS_CALENDAR,
        { url: FEED_URL }
      )
      const second = await invokeHandler<IcsCalendarMutationResponse>(
        CalendarChannels.invoke.SUBSCRIBE_ICS_CALENDAR,
        { url: 'https://league.example.com/fixtures.ics' }
      )

      const legacy = await invokeHandler<IcsCalendarMutationResponse>(
        CalendarChannels.invoke.UNSUBSCRIBE_ICS_CALENDAR,
        { sourceId: first.source!.id }
      )
      const generic = await invokeHandler<CalendarProviderMutationResponse>(
        CalendarChannels.invoke.DISCONNECT_PROVIDER,
        { provider: 'ics', sourceId: second.source!.id }
      )
      expect(legacy.source!.archivedAt).toEqual(expect.any(String))
      expect(generic.success).toBe(true)
      expect(generic.source!.archivedAt).toEqual(expect.any(String))
      expect(mirroredEventCount()).toBe(0)
    })
  })

  describe('Google through the generic channels and the legacy aliases', () => {
    it('list-provider-calendars matches list-google-calendars', async () => {
      mocks.resolveDefaultGoogleAccountId.mockReturnValue('edge@example.com')
      const listed = {
        calendars: [{ id: 'primary', title: 'Primary' }],
        primary: { id: 'primary', title: 'Primary' },
        currentDefaultId: 'primary'
      }
      mocks.listGoogleCalendars.mockResolvedValue(listed)

      const legacy = await invokeHandler(CalendarChannels.invoke.LIST_GOOGLE_CALENDARS, {})
      const generic = await invokeHandler<ListProviderCalendarsResponse>(
        CalendarChannels.invoke.LIST_PROVIDER_CALENDARS,
        { provider: 'google' }
      )
      expect(legacy).toEqual(listed)
      expect(generic).toEqual({ provider: 'google', ...listed })
    })

    it('set-default-provider-calendar matches set-default-google-calendar', async () => {
      mocks.setDefaultGoogleCalendar.mockReturnValue({ success: true })
      const legacy = await invokeHandler(CalendarChannels.invoke.SET_DEFAULT_GOOGLE_CALENDAR, {
        calendarId: 'primary'
      })
      const generic = await invokeHandler(CalendarChannels.invoke.SET_DEFAULT_PROVIDER_CALENDAR, {
        provider: 'google',
        calendarId: 'primary'
      })
      expect(generic).toEqual(legacy)
      expect(mocks.setDefaultGoogleCalendar.mock.calls[1][1]).toEqual(
        mocks.setDefaultGoogleCalendar.mock.calls[0][1]
      )
    })

    it('retry-source-sync matches retry-google-source-sync, success and failure', async () => {
      seedGoogleCalendar(dbResult.db)
      const legacyOk = await invokeHandler<RetryCalendarSourceSyncResponse>(
        CalendarChannels.invoke.RETRY_GOOGLE_CALENDAR_SOURCE_SYNC,
        { sourceId: 'google-calendar:edge' }
      )
      const genericOk = await invokeHandler<RetryCalendarSourceSyncResponse>(
        CalendarChannels.invoke.RETRY_SOURCE_SYNC,
        { sourceId: 'google-calendar:edge' }
      )
      expect(genericOk).toEqual(legacyOk)
      expect(genericOk.success).toBe(true)

      mocks.syncGoogleCalendarSource.mockRejectedValue(new Error('retry failed'))
      const legacyFailed = await invokeHandler(
        CalendarChannels.invoke.RETRY_GOOGLE_CALENDAR_SOURCE_SYNC,
        { sourceId: 'google-calendar:edge' }
      )
      const genericFailed = await invokeHandler(CalendarChannels.invoke.RETRY_SOURCE_SYNC, {
        sourceId: 'google-calendar:edge'
      })
      expect(genericFailed).toEqual(legacyFailed)
      expect(genericFailed).toMatchObject({ success: false, error: 'retry failed' })
    })

    it('the legacy retry channel still refuses non-Google sources with its own message', async () => {
      stubFeed(() => new Response(FEED, { status: 200 }))
      const subscribed = await invokeHandler<IcsCalendarMutationResponse>(
        CalendarChannels.invoke.SUBSCRIBE_ICS_CALENDAR,
        { url: FEED_URL }
      )
      expect(
        await invokeHandler(CalendarChannels.invoke.RETRY_GOOGLE_CALENDAR_SOURCE_SYNC, {
          sourceId: subscribed.source!.id
        })
      ).toEqual({
        success: false,
        source: null,
        error: 'Only Google calendar sources can be retried'
      })
    })
  })
})
