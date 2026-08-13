import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { sql } from 'drizzle-orm'
import { mockIpcMain, resetIpcMocks, invokeHandler } from '@tests/utils/mock-ipc'
import {
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult,
  type TestDb,
  asClientDb
} from '@tests/utils/test-db'
import { CalendarChannels } from '@memry/contracts/ipc-channels'

const handleCalls: unknown[][] = []
const removeHandlerCalls: string[] = []
const webContentsSend = vi.fn()
const mockConnectGoogleCalendar = vi.fn()
const mockDisconnectGoogleCalendar = vi.fn()
const mockHasGoogleCalendarLocalAuth = vi.fn()
const mockHasAnyGoogleCalendarLocalAuth = vi.fn()
const mockListGoogleAccountIds = vi.fn(() => [] as string[])
const mockResolveDefaultGoogleAccountId = vi.fn(() => null as string | null)
const mockDiscoverGoogleCalendarSources = vi.fn()
const mockSyncGoogleCalendarNow = vi.fn()
const mockSyncGoogleCalendarSource = vi.fn()
const mockSyncLocalSourceToGoogleCalendar = vi.fn(async () => null)
const mockStartGoogleCalendarSyncRunner = vi.fn(async () => {})
const mockStopGoogleCalendarSyncRunner = vi.fn()
const mockIsMemryUserSignedIn = vi.fn(async () => true)
const mockPushSelectionToggle = vi.fn()
const mockListGoogleCalendars = vi.fn()
const mockSetDefaultGoogleCalendar = vi.fn()
const mockCreateGoogleCalendarClient = vi.fn((options: unknown) => ({ options }))
const mockPromoteExternalEvent = vi.fn()

const mockCalendarPromoteErrors = vi.hoisted(() => {
  class ExternalEventNotFoundError extends Error {}
  class ExternalEventSourceMissingError extends Error {}

  return {
    ExternalEventNotFoundError,
    ExternalEventSourceMissingError
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: unknown) => {
      handleCalls.push([channel, handler])
      mockIpcMain.handle(channel, handler as Parameters<typeof mockIpcMain.handle>[1])
    }),
    removeHandler: vi.fn((channel: string) => {
      removeHandlerCalls.push(channel)
      mockIpcMain.removeHandler(channel)
    })
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => [
      { isDestroyed: () => false, webContents: { send: webContentsSend } }
    ])
  }
}))

vi.mock('../database', () => ({
  getDatabase: vi.fn(),
  requireDatabase: vi.fn(),
  getIndexDatabase: vi.fn()
}))

vi.mock('../lib/id', () => ({
  generateId: vi.fn(() => 'calendar-event-generated-id')
}))

vi.mock('../sync/local-mutations', () => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn()
}))

vi.mock('../calendar/providers/google/oauth', () => ({
  connectGoogleCalendar: (...args: unknown[]) => mockConnectGoogleCalendar(...args),
  disconnectGoogleCalendar: (...args: unknown[]) => mockDisconnectGoogleCalendar(...args),
  hasGoogleCalendarLocalAuth: (...args: unknown[]) => mockHasGoogleCalendarLocalAuth(...args),
  hasAnyGoogleCalendarLocalAuth: (...args: unknown[]) => mockHasAnyGoogleCalendarLocalAuth(...args),
  listGoogleAccountIds: (...args: unknown[]) => mockListGoogleAccountIds(...args),
  resolveDefaultGoogleAccountId: (...args: unknown[]) => mockResolveDefaultGoogleAccountId(...args)
}))

vi.mock('../calendar/providers/google/sync-service', () => ({
  discoverGoogleCalendarSources: (...args: unknown[]) => mockDiscoverGoogleCalendarSources(...args),
  syncGoogleCalendarNow: (...args: unknown[]) => mockSyncGoogleCalendarNow(...args),
  syncGoogleCalendarSource: (...args: unknown[]) => mockSyncGoogleCalendarSource(...args),
  syncLocalSourceToGoogleCalendar: (...args: unknown[]) =>
    mockSyncLocalSourceToGoogleCalendar(...args),
  startGoogleCalendarSyncRunner: (...args: unknown[]) => mockStartGoogleCalendarSyncRunner(...args),
  stopGoogleCalendarSyncRunner: (...args: unknown[]) => mockStopGoogleCalendarSyncRunner(...args)
}))

vi.mock('../calendar/providers/google/onboarding', () => ({
  listGoogleCalendars: (...args: unknown[]) => mockListGoogleCalendars(...args),
  setDefaultGoogleCalendar: (...args: unknown[]) => mockSetDefaultGoogleCalendar(...args)
}))

vi.mock('../calendar/providers/google/client', () => ({
  createGoogleCalendarClient: (...args: unknown[]) => mockCreateGoogleCalendarClient(...args)
}))

vi.mock('../calendar/providers/google/push-runtime', () => ({
  getGooglePushRuntime: vi.fn(() => ({
    handleSelectionToggle: (...args: unknown[]) => mockPushSelectionToggle(...args)
  }))
}))

vi.mock('../calendar/promote-external-event', () => ({
  promoteExternalEvent: (...args: unknown[]) => mockPromoteExternalEvent(...args),
  ExternalEventNotFoundError: mockCalendarPromoteErrors.ExternalEventNotFoundError,
  ExternalEventSourceMissingError: mockCalendarPromoteErrors.ExternalEventSourceMissingError
}))

vi.mock('../auth-state', () => ({
  isMemryUserSignedIn: (...args: unknown[]) => mockIsMemryUserSignedIn(...args)
}))

import { getDatabase, getIndexDatabase, requireDatabase } from '../database'
import {
  enqueueLocalSyncCreate,
  enqueueLocalSyncDelete,
  enqueueLocalSyncUpdate
} from '../sync/local-mutations'
import { registerCalendarHandlers, unregisterCalendarHandlers } from './calendar-handlers'
import { GOOGLE_CAPABILITIES } from '../calendar/providers/google/provider-definition'

/**
 * Every provider status now carries the registry's capability record. Asserted
 * against the definition itself rather than a copied literal, so a capability
 * flip has to be a deliberate edit in one place.
 */
const GOOGLE_PROVIDER_CAPABILITIES = GOOGLE_CAPABILITIES

describe('calendar-handlers', () => {
  let dbResult: TestDatabaseResult
  let db: TestDb
  let indexDbResult: TestDatabaseResult

  beforeEach(() => {
    resetIpcMocks()
    vi.clearAllMocks()
    handleCalls.length = 0
    removeHandlerCalls.length = 0
    dbResult = createTestDataDb()
    db = dbResult.db
    indexDbResult = createTestIndexDb()
    ;(getDatabase as Mock).mockReturnValue(asClientDb(db))
    ;(requireDatabase as Mock).mockReturnValue(asClientDb(db))
    ;(getIndexDatabase as Mock).mockReturnValue(asClientDb(indexDbResult.db))
    mockHasGoogleCalendarLocalAuth.mockResolvedValue(false)
    mockHasAnyGoogleCalendarLocalAuth.mockResolvedValue(false)
    mockListGoogleAccountIds.mockReturnValue([])
    mockResolveDefaultGoogleAccountId.mockReturnValue(null)
    mockDisconnectGoogleCalendar.mockResolvedValue(undefined)
    mockIsMemryUserSignedIn.mockResolvedValue(true)
    mockSyncGoogleCalendarSource.mockResolvedValue(undefined)
    mockPushSelectionToggle.mockResolvedValue(undefined)
    mockListGoogleCalendars.mockResolvedValue({
      calendars: [{ id: 'primary', summary: 'Primary' }],
      primary: { id: 'primary', summary: 'Primary' },
      currentDefaultId: 'primary'
    })
    mockSetDefaultGoogleCalendar.mockReturnValue({
      success: true,
      source: { id: 'google-calendar:primary', remoteId: 'primary' }
    })
    mockPromoteExternalEvent.mockReturnValue({
      success: true,
      eventId: 'promoted-event'
    })
  })

  afterEach(() => {
    unregisterCalendarHandlers()
    dbResult.close()
    indexDbResult.close()
  })

  it('registers all calendar handlers', () => {
    registerCalendarHandlers()
    expect(handleCalls.length).toBe(Object.values(CalendarChannels.invoke).length)
  })

  it('creates, updates, deletes, and lists memrynote events', async () => {
    registerCalendarHandlers()

    const created = await invokeHandler(CalendarChannels.invoke.CREATE_EVENT, {
      title: 'Quarterly planning',
      description: 'Align roadmap',
      location: 'Studio',
      startAt: '2026-04-12T09:00:00.000Z',
      endAt: '2026-04-12T10:00:00.000Z',
      timezone: 'UTC',
      isAllDay: false
    })

    expect(created).toEqual({
      success: true,
      event: expect.objectContaining({
        id: 'calendar-event-generated-id',
        title: 'Quarterly planning',
        description: 'Align roadmap',
        location: 'Studio'
      })
    })
    expect(enqueueLocalSyncCreate).toHaveBeenCalledWith(
      'calendar_event',
      'calendar-event-generated-id'
    )
    expect(webContentsSend).toHaveBeenCalledWith(CalendarChannels.events.CHANGED, {
      entityType: 'calendar_event',
      id: 'calendar-event-generated-id'
    })

    const listed = await invokeHandler(CalendarChannels.invoke.LIST_EVENTS, {})
    expect(listed.events).toEqual([
      expect.objectContaining({
        id: 'calendar-event-generated-id',
        title: 'Quarterly planning'
      })
    ])

    const updated = await invokeHandler(CalendarChannels.invoke.UPDATE_EVENT, {
      id: 'calendar-event-generated-id',
      title: 'Quarterly planning review',
      endAt: '2026-04-12T10:30:00.000Z'
    })
    expect(updated).toEqual({
      success: true,
      event: expect.objectContaining({
        id: 'calendar-event-generated-id',
        title: 'Quarterly planning review',
        endAt: '2026-04-12T10:30:00.000Z'
      })
    })
    expect(enqueueLocalSyncUpdate).toHaveBeenCalledWith(
      'calendar_event',
      'calendar-event-generated-id',
      ['title', 'endAt']
    )

    const deleted = await invokeHandler(
      CalendarChannels.invoke.DELETE_EVENT,
      'calendar-event-generated-id'
    )
    expect(deleted).toEqual({ success: true })
    expect(enqueueLocalSyncDelete).toHaveBeenCalledWith(
      'calendar_event',
      'calendar-event-generated-id',
      expect.any(String)
    )

    const afterDelete = await invokeHandler(CalendarChannels.invoke.LIST_EVENTS, {})
    expect(afterDelete.events).toEqual([])
  })

  it('persists targetCalendarId through CREATE_EVENT and respects it on UPDATE_EVENT (M2 review fix)', async () => {
    registerCalendarHandlers()

    const created = await invokeHandler(CalendarChannels.invoke.CREATE_EVENT, {
      title: 'Work sync',
      startAt: '2026-04-12T09:00:00.000Z',
      endAt: '2026-04-12T10:00:00.000Z',
      timezone: 'UTC',
      isAllDay: false,
      targetCalendarId: 'work@group.calendar.google.com'
    })

    expect(created).toEqual({
      success: true,
      event: expect.objectContaining({
        id: 'calendar-event-generated-id',
        targetCalendarId: 'work@group.calendar.google.com'
      })
    })

    // Switch the event to a different Google calendar through UPDATE_EVENT
    const retargeted = await invokeHandler(CalendarChannels.invoke.UPDATE_EVENT, {
      id: 'calendar-event-generated-id',
      targetCalendarId: 'personal@group.calendar.google.com'
    })
    expect(retargeted).toEqual({
      success: true,
      event: expect.objectContaining({
        targetCalendarId: 'personal@group.calendar.google.com'
      })
    })

    // Explicit null clears the target (falls back to default at push time)
    const cleared = await invokeHandler(CalendarChannels.invoke.UPDATE_EVENT, {
      id: 'calendar-event-generated-id',
      targetCalendarId: null
    })
    expect(cleared).toEqual({
      success: true,
      event: expect.objectContaining({ targetCalendarId: null })
    })

    // Omitted targetCalendarId in a partial update preserves the current value
    await invokeHandler(CalendarChannels.invoke.UPDATE_EVENT, {
      id: 'calendar-event-generated-id',
      targetCalendarId: 'home@group.calendar.google.com'
    })
    const preserved = await invokeHandler(CalendarChannels.invoke.UPDATE_EVENT, {
      id: 'calendar-event-generated-id',
      title: 'Title change only'
    })
    expect(preserved).toEqual({
      success: true,
      event: expect.objectContaining({
        title: 'Title change only',
        targetCalendarId: 'home@group.calendar.google.com'
      })
    })
  })

  it('returns projected range items for memrynote and imported provider events', async () => {
    registerCalendarHandlers()

    db.run(sql`
      INSERT INTO calendar_events (
        id,
        title,
        description,
        start_at,
        end_at,
        timezone,
        is_all_day,
        created_at,
        modified_at
      )
      VALUES (
        ${'event-1'},
        ${'Quarterly planning'},
        ${'Align roadmap'},
        ${'2026-04-12T09:00:00.000Z'},
        ${'2026-04-12T10:00:00.000Z'},
        ${'UTC'},
        ${0},
        ${'2026-04-12T08:00:00.000Z'},
        ${'2026-04-12T08:00:00.000Z'}
      )
    `)

    db.run(sql`
      INSERT INTO calendar_sources (
        id,
        provider,
        kind,
        account_id,
        remote_id,
        title,
        timezone,
        is_selected,
        sync_status,
        created_at,
        modified_at
      )
      VALUES (
        ${'google-calendar-1'},
        ${'google'},
        ${'calendar'},
        ${'google-account-1'},
        ${'remote-calendar-1'},
        ${'Work'},
        ${'Europe/Istanbul'},
        ${1},
        ${'ok'},
        ${'2026-04-12T08:00:00.000Z'},
        ${'2026-04-12T08:00:00.000Z'}
      )
    `)

    db.run(sql`
      INSERT INTO calendar_external_events (
        id,
        source_id,
        remote_event_id,
        title,
        start_at,
        end_at,
        timezone,
        is_all_day,
        status,
        created_at,
        modified_at
      )
      VALUES (
        ${'external-event-1'},
        ${'google-calendar-1'},
        ${'google-remote-event-1'},
        ${'Design review'},
        ${'2026-04-12T11:00:00.000Z'},
        ${'2026-04-12T12:00:00.000Z'},
        ${'Europe/Istanbul'},
        ${0},
        ${'confirmed'},
        ${'2026-04-12T08:10:00.000Z'},
        ${'2026-04-12T08:10:00.000Z'}
      )
    `)

    const result = await invokeHandler(CalendarChannels.invoke.GET_RANGE, {
      startAt: '2026-04-12T00:00:00.000Z',
      endAt: '2026-04-13T00:00:00.000Z'
    })

    expect(result.items).toEqual([
      expect.objectContaining({
        projectionId: 'event:event-1',
        sourceType: 'event',
        sourceId: 'event-1',
        title: 'Quarterly planning',
        visualType: 'event'
      }),
      expect.objectContaining({
        projectionId: 'external_event:external-event-1',
        sourceType: 'external_event',
        sourceId: 'external-event-1',
        title: 'Design review',
        visualType: 'external_event',
        source: expect.objectContaining({
          provider: 'google',
          calendarSourceId: 'google-calendar-1',
          title: 'Work'
        })
      })
    ])
  })

  it('lists sources and reports synced provider metadata separately from local auth state', async () => {
    registerCalendarHandlers()

    db.run(sql`
      INSERT INTO calendar_sources (
        id,
        provider,
        kind,
        account_id,
        remote_id,
        title,
        timezone,
        is_selected,
        sync_status,
        created_at,
        modified_at
      )
      VALUES (
        ${'google-account-1'},
        ${'google'},
        ${'account'},
        ${null},
        ${'remote-account-1'},
        ${'h4yfans@gmail.com'},
        ${'Europe/Istanbul'},
        ${0},
        ${'ok'},
        ${'2026-04-12T08:00:00.000Z'},
        ${'2026-04-12T08:00:00.000Z'}
      )
    `)

    db.run(sql`
      INSERT INTO calendar_sources (
        id,
        provider,
        kind,
        account_id,
        remote_id,
        title,
        timezone,
        is_selected,
        sync_status,
        created_at,
        modified_at
      )
      VALUES (
        ${'google-calendar-1'},
        ${'google'},
        ${'calendar'},
        ${'google-account-1'},
        ${'remote-calendar-1'},
        ${'Work'},
        ${'Europe/Istanbul'},
        ${1},
        ${'ok'},
        ${'2026-04-12T08:01:00.000Z'},
        ${'2026-04-12T08:01:00.000Z'}
      )
    `)

    const sources = await invokeHandler(CalendarChannels.invoke.LIST_SOURCES, {
      provider: 'google'
    })
    expect(sources.sources).toEqual([
      expect.objectContaining({ id: 'google-account-1', kind: 'account' }),
      expect.objectContaining({ id: 'google-calendar-1', kind: 'calendar', isSelected: true })
    ])

    const status = await invokeHandler(CalendarChannels.invoke.GET_PROVIDER_STATUS, {
      provider: 'google'
    })
    expect(status).toEqual({
      provider: 'google',
      capabilities: GOOGLE_PROVIDER_CAPABILITIES,
      connected: true,
      hasLocalAuth: false,
      account: expect.objectContaining({
        id: 'google-account-1',
        title: 'h4yfans@gmail.com'
      }),
      accounts: [],
      calendars: {
        total: 1,
        selected: 1,
        memryManaged: 0
      },
      lastSyncedAt: null
    })
  })

  it('connects and disconnects the Google provider through the provider-specific auth module', async () => {
    registerCalendarHandlers()
    mockConnectGoogleCalendar.mockResolvedValue({
      accountId: 'user@example.com',
      account: {
        remoteId: 'user@example.com',
        email: 'user@example.com',
        title: 'User Example',
        timezone: 'Europe/Istanbul'
      },
      primaryCalendar: {
        remoteId: 'user@example.com',
        title: 'User Example',
        timezone: 'Europe/Istanbul',
        color: '#0ea5e9',
        isPrimary: true
      }
    })
    mockHasAnyGoogleCalendarLocalAuth.mockResolvedValue(true)
    mockListGoogleAccountIds.mockReturnValue(['user@example.com'])

    const connect = await invokeHandler(CalendarChannels.invoke.CONNECT_PROVIDER, {
      provider: 'google'
    })
    expect(connect).toEqual({
      success: true,
      status: {
        provider: 'google',
        capabilities: GOOGLE_PROVIDER_CAPABILITIES,
        connected: true,
        hasLocalAuth: true,
        account: {
          id: 'google-account:user@example.com',
          title: 'User Example'
        },
        accounts: expect.arrayContaining([
          expect.objectContaining({
            accountId: 'user@example.com',
            email: 'user@example.com'
          })
        ]),
        calendars: {
          total: 1,
          selected: 1,
          memryManaged: 0
        },
        lastSyncedAt: null
      }
    })
    expect(mockConnectGoogleCalendar).toHaveBeenCalledTimes(1)

    const sources = await invokeHandler(CalendarChannels.invoke.LIST_SOURCES, {
      provider: 'google'
    })
    expect(sources.sources).toEqual([
      expect.objectContaining({ id: 'google-account:user@example.com', kind: 'account' }),
      expect.objectContaining({
        id: 'google-calendar:user@example.com',
        kind: 'calendar',
        isSelected: true
      })
    ])

    mockHasAnyGoogleCalendarLocalAuth.mockResolvedValue(false)

    const disconnect = await invokeHandler(CalendarChannels.invoke.DISCONNECT_PROVIDER, {
      provider: 'google'
    })
    expect(disconnect).toEqual({
      success: true,
      status: {
        provider: 'google',
        capabilities: GOOGLE_PROVIDER_CAPABILITIES,
        connected: false,
        hasLocalAuth: false,
        account: null,
        accounts: [],
        calendars: {
          total: 0,
          selected: 0,
          memryManaged: 0
        },
        lastSyncedAt: null
      }
    })
    expect(mockDisconnectGoogleCalendar).toHaveBeenCalledTimes(1)
  })

  it('updates Google calendar source selection state', async () => {
    registerCalendarHandlers()

    db.run(sql`
      INSERT INTO calendar_sources (
        id,
        provider,
        kind,
        account_id,
        remote_id,
        title,
        timezone,
        is_selected,
        sync_status,
        created_at,
        modified_at
      )
      VALUES (
        ${'google-calendar-1'},
        ${'google'},
        ${'calendar'},
        ${'google-account-1'},
        ${'remote-calendar-1'},
        ${'Work'},
        ${'Europe/Istanbul'},
        ${1},
        ${'ok'},
        ${'2026-04-12T08:01:00.000Z'},
        ${'2026-04-12T08:01:00.000Z'}
      )
    `)

    const updated = await invokeHandler(CalendarChannels.invoke.UPDATE_SOURCE_SELECTION, {
      id: 'google-calendar-1',
      isSelected: false
    })

    expect(updated).toEqual({
      success: true,
      source: expect.objectContaining({
        id: 'google-calendar-1',
        isSelected: false
      })
    })
    expect(enqueueLocalSyncUpdate).toHaveBeenCalledWith('calendar_source', 'google-calendar-1')
    expect(webContentsSend).toHaveBeenCalledWith(CalendarChannels.events.CHANGED, {
      entityType: 'calendar_source',
      id: 'google-calendar-1'
    })
    expect(mockPushSelectionToggle).toHaveBeenCalledWith({
      sourceId: 'google-calendar-1',
      isSelected: false,
      calendarId: 'remote-calendar-1'
    })
  })

  it('brings every calendar on the account into the picker when connecting', async () => {
    registerCalendarHandlers()
    mockConnectGoogleCalendar.mockResolvedValue({
      accountId: 'work@example.com',
      account: {
        remoteId: 'work@example.com',
        email: 'work@example.com',
        title: 'Work Example',
        timezone: 'Europe/Istanbul'
      },
      primaryCalendar: {
        remoteId: 'work@example.com',
        title: 'Work Example',
        timezone: 'Europe/Istanbul',
        color: '#0ea5e9',
        isPrimary: true
      }
    })
    mockHasAnyGoogleCalendarLocalAuth.mockResolvedValue(true)
    mockListGoogleAccountIds.mockReturnValue(['work@example.com'])
    // Stand-in for the real discovery pass, which has its own real-DB tests.
    mockDiscoverGoogleCalendarSources.mockImplementation(async () => {
      db.run(sql`
        INSERT INTO calendar_sources (
          id, provider, kind, account_id, remote_id, title, timezone,
          is_selected, sync_status, created_at, modified_at
        )
        VALUES (
          ${'google-calendar:team@group.calendar.google.com'}, ${'google'}, ${'calendar'},
          ${'work@example.com'}, ${'team@group.calendar.google.com'}, ${'Team'},
          ${'Europe/Istanbul'}, ${0}, ${'idle'},
          ${'2026-04-12T08:01:00.000Z'}, ${'2026-04-12T08:01:00.000Z'}
        )
      `)
    })

    await invokeHandler(CalendarChannels.invoke.CONNECT_PROVIDER, { provider: 'google' })

    expect(mockDiscoverGoogleCalendarSources).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'work@example.com'
    )

    const sources = await invokeHandler(CalendarChannels.invoke.LIST_SOURCES, {
      provider: 'google',
      kind: 'calendar'
    })

    // The account's other calendars have to reach the picker; otherwise there
    // is nothing for the user to turn on and only the primary ever syncs.
    expect(sources.sources.map((source: { remoteId: string }) => source.remoteId)).toEqual(
      expect.arrayContaining(['work@example.com', 'team@group.calendar.google.com'])
    )
  })

  it('deletes a de-selected calendar events and leaves the other calendars alone', async () => {
    registerCalendarHandlers()

    for (const [id, remoteId, title] of [
      ['google-calendar-1', 'remote-calendar-1', 'Work'],
      ['google-calendar-2', 'remote-calendar-2', 'Personal']
    ]) {
      db.run(sql`
        INSERT INTO calendar_sources (
          id, provider, kind, account_id, remote_id, title, timezone,
          is_selected, sync_status, created_at, modified_at
        )
        VALUES (
          ${id}, ${'google'}, ${'calendar'}, ${'google-account-1'}, ${remoteId}, ${title},
          ${'Europe/Istanbul'}, ${1}, ${'ok'},
          ${'2026-04-12T08:01:00.000Z'}, ${'2026-04-12T08:01:00.000Z'}
        )
      `)
    }

    for (const [id, sourceId, remoteEventId, title] of [
      ['ext-1', 'google-calendar-1', 'remote-event-1', 'Standup'],
      ['ext-2', 'google-calendar-1', 'remote-event-2', 'Retro'],
      ['ext-3', 'google-calendar-2', 'remote-event-3', 'Dentist']
    ]) {
      db.run(sql`
        INSERT INTO calendar_external_events (
          id, source_id, remote_event_id, title, start_at, created_at, modified_at
        )
        VALUES (
          ${id}, ${sourceId}, ${remoteEventId}, ${title}, ${'2026-04-12T09:00:00.000Z'},
          ${'2026-04-12T08:01:00.000Z'}, ${'2026-04-12T08:01:00.000Z'}
        )
      `)
    }

    await invokeHandler(CalendarChannels.invoke.UPDATE_SOURCE_SELECTION, {
      id: 'google-calendar-1',
      isSelected: false
    })

    const remaining = db
      .all<{ id: string }>(sql`SELECT id FROM calendar_external_events ORDER BY id`)
      .map((row) => row.id)

    // Turning a calendar off has to take its events with it — otherwise they
    // linger on the calendar view with nothing left to refresh or remove them.
    expect(remaining).toEqual(['ext-3'])
    expect(enqueueLocalSyncDelete).toHaveBeenCalledWith(
      'calendar_external_event',
      'ext-1',
      expect.any(String)
    )
    expect(enqueueLocalSyncDelete).toHaveBeenCalledWith(
      'calendar_external_event',
      'ext-2',
      expect.any(String)
    )
  })

  it('keeps a calendar events when it is turned back on', async () => {
    registerCalendarHandlers()

    db.run(sql`
      INSERT INTO calendar_sources (
        id, provider, kind, account_id, remote_id, title, timezone,
        is_selected, sync_status, created_at, modified_at
      )
      VALUES (
        ${'google-calendar-1'}, ${'google'}, ${'calendar'}, ${'google-account-1'},
        ${'remote-calendar-1'}, ${'Work'}, ${'Europe/Istanbul'}, ${0}, ${'idle'},
        ${'2026-04-12T08:01:00.000Z'}, ${'2026-04-12T08:01:00.000Z'}
      )
    `)
    db.run(sql`
      INSERT INTO calendar_external_events (
        id, source_id, remote_event_id, title, start_at, created_at, modified_at
      )
      VALUES (
        ${'ext-1'}, ${'google-calendar-1'}, ${'remote-event-1'}, ${'Standup'},
        ${'2026-04-12T09:00:00.000Z'}, ${'2026-04-12T08:01:00.000Z'},
        ${'2026-04-12T08:01:00.000Z'}
      )
    `)

    await invokeHandler(CalendarChannels.invoke.UPDATE_SOURCE_SELECTION, {
      id: 'google-calendar-1',
      isSelected: true
    })

    const remaining = db
      .all<{ id: string }>(sql`SELECT id FROM calendar_external_events`)
      .map((row) => row.id)

    expect(remaining).toEqual(['ext-1'])
    expect(enqueueLocalSyncDelete).not.toHaveBeenCalled()
  })

  it('covers calendar handler error and provider edge paths', async () => {
    registerCalendarHandlers()

    expect(await invokeHandler(CalendarChannels.invoke.GET_EVENT, 'missing-event')).toBeNull()
    expect(
      await invokeHandler(CalendarChannels.invoke.UPDATE_EVENT, {
        id: 'missing-event',
        title: 'Nope'
      })
    ).toEqual({ success: false, event: null, error: 'Calendar event not found' })
    expect(await invokeHandler(CalendarChannels.invoke.DELETE_EVENT, 'missing-event')).toEqual({
      success: false,
      error: 'Calendar event not found'
    })

    expect(
      await invokeHandler(CalendarChannels.invoke.UPDATE_SOURCE_SELECTION, {
        id: 'missing-source',
        isSelected: true
      })
    ).toEqual({
      success: false,
      source: null,
      error: 'Calendar source not found'
    })

    db.run(sql`
      INSERT INTO calendar_sources (
        id, provider, kind, account_id, remote_id, title, timezone,
        is_selected, sync_status, created_at, modified_at
      ) VALUES (
        ${'google-account:edge@example.com'}, ${'google'}, ${'account'},
        ${'edge@example.com'}, ${'edge@example.com'}, ${'Edge Account'}, ${'UTC'},
        ${0}, ${'ok'}, ${'2026-04-12T08:00:00.000Z'}, ${'2026-04-12T08:00:00.000Z'}
      )
    `)

    expect(
      await invokeHandler(CalendarChannels.invoke.UPDATE_SOURCE_SELECTION, {
        id: 'google-account:edge@example.com',
        isSelected: true
      })
    ).toEqual({
      success: false,
      source: null,
      error: 'Only calendar sources can be selected'
    })

    mockIsMemryUserSignedIn.mockResolvedValueOnce(false)
    const unsignedRefresh = await invokeHandler(CalendarChannels.invoke.REFRESH_PROVIDER, {
      provider: 'google'
    })
    expect(unsignedRefresh).toEqual(
      expect.objectContaining({
        success: false,
        error: 'Sign in to memrynote before refreshing Google Calendar'
      })
    )

    expect(await invokeHandler(CalendarChannels.invoke.LIST_GOOGLE_CALENDARS, {})).toEqual({
      calendars: [],
      primary: null,
      currentDefaultId: null
    })

    mockResolveDefaultGoogleAccountId.mockReturnValue('edge@example.com')
    const listedCalendars = await invokeHandler(CalendarChannels.invoke.LIST_GOOGLE_CALENDARS, {})
    expect(mockCreateGoogleCalendarClient).toHaveBeenCalledWith({ accountId: 'edge@example.com' })
    expect(listedCalendars).toEqual({
      calendars: [{ id: 'primary', summary: 'Primary' }],
      primary: { id: 'primary', summary: 'Primary' },
      currentDefaultId: 'primary'
    })

    expect(
      await invokeHandler(CalendarChannels.invoke.SET_DEFAULT_GOOGLE_CALENDAR, {
        calendarId: 'primary'
      })
    ).toEqual({
      success: true,
      source: { id: 'google-calendar:primary', remoteId: 'primary' }
    })

    expect(
      await invokeHandler(CalendarChannels.invoke.RETRY_GOOGLE_CALENDAR_SOURCE_SYNC, {
        sourceId: 'missing-source'
      })
    ).toEqual({ success: false, source: null, error: 'Calendar source not found' })

    expect(
      await invokeHandler(CalendarChannels.invoke.RETRY_GOOGLE_CALENDAR_SOURCE_SYNC, {
        sourceId: 'google-account:edge@example.com'
      })
    ).toEqual({
      success: false,
      source: null,
      error: 'Only Google calendar sources can be retried'
    })

    db.run(sql`
      INSERT INTO calendar_sources (
        id, provider, kind, account_id, remote_id, title, timezone,
        is_selected, sync_status, created_at, modified_at
      ) VALUES (
        ${'google-calendar:edge'}, ${'google'}, ${'calendar'},
        ${'edge@example.com'}, ${'edge-calendar'}, ${'Edge Calendar'}, ${'UTC'},
        ${1}, ${'error'}, ${'2026-04-12T08:00:00.000Z'}, ${'2026-04-12T08:00:00.000Z'}
      )
    `)
    mockSyncGoogleCalendarSource.mockRejectedValueOnce(new Error('retry failed'))
    expect(
      await invokeHandler(CalendarChannels.invoke.RETRY_GOOGLE_CALENDAR_SOURCE_SYNC, {
        sourceId: 'google-calendar:edge'
      })
    ).toEqual({
      success: false,
      source: expect.objectContaining({ id: 'google-calendar:edge' }),
      error: 'retry failed'
    })

    expect(
      await invokeHandler(CalendarChannels.invoke.PROMOTE_EXTERNAL_EVENT, {
        externalEventId: 'external-event-1'
      })
    ).toEqual({ success: true, eventId: 'promoted-event' })

    mockPromoteExternalEvent.mockImplementationOnce(() => {
      throw new mockCalendarPromoteErrors.ExternalEventNotFoundError('external missing')
    })
    expect(
      await invokeHandler(CalendarChannels.invoke.PROMOTE_EXTERNAL_EVENT, {
        externalEventId: 'missing-external'
      })
    ).toEqual({ success: false, eventId: null, error: 'external missing' })
  })

  it('returns one account in status.accounts per connected Google account (M6 T3)', async () => {
    registerCalendarHandlers()

    db.run(sql`
      INSERT INTO calendar_sources (
        id, provider, kind, account_id, remote_id, title, timezone,
        is_selected, sync_status, last_synced_at, metadata, created_at, modified_at
      ) VALUES (
        ${'google-account:alice@example.com'}, ${'google'}, ${'account'},
        ${'alice@example.com'}, ${'alice@example.com'}, ${'Alice'}, ${'UTC'},
        ${0}, ${'ok'}, ${'2026-04-15T10:00:00.000Z'},
        ${JSON.stringify({ email: 'alice@example.com' })},
        ${'2026-04-15T10:00:00.000Z'}, ${'2026-04-15T10:00:00.000Z'}
      )
    `)
    db.run(sql`
      INSERT INTO calendar_sources (
        id, provider, kind, account_id, remote_id, title, timezone,
        is_selected, sync_status, last_synced_at, metadata, created_at, modified_at
      ) VALUES (
        ${'google-account:bob@example.com'}, ${'google'}, ${'account'},
        ${'bob@example.com'}, ${'bob@example.com'}, ${'Bob'}, ${'UTC'},
        ${0}, ${'error'}, ${'2026-04-15T09:00:00.000Z'},
        ${JSON.stringify({ email: 'bob@example.com', lastError: 'token revoked by Google' })},
        ${'2026-04-15T09:00:00.000Z'}, ${'2026-04-15T09:00:00.000Z'}
      )
    `)

    mockHasAnyGoogleCalendarLocalAuth.mockResolvedValue(true)
    mockHasGoogleCalendarLocalAuth.mockImplementation(async (accountId: string) => {
      // Bob's keychain entry was wiped (e.g. token revoked); Alice still has tokens.
      return accountId === 'alice@example.com'
    })

    const status = await invokeHandler(CalendarChannels.invoke.GET_PROVIDER_STATUS, {
      provider: 'google'
    })

    expect(status.accounts).toHaveLength(2)
    expect(status.accounts).toEqual(
      expect.arrayContaining([
        {
          accountId: 'alice@example.com',
          email: 'alice@example.com',
          status: 'connected',
          lastSyncedAt: '2026-04-15T10:00:00.000Z',
          lastError: null
        },
        {
          accountId: 'bob@example.com',
          email: 'bob@example.com',
          status: 'reconnect_required',
          lastSyncedAt: '2026-04-15T09:00:00.000Z',
          lastError: 'token revoked by Google'
        }
      ])
    )
  })

  it('RETRY_GOOGLE_CALENDAR_SOURCE_SYNC fires syncGoogleCalendarSource and returns the refreshed source (M6 T6)', async () => {
    registerCalendarHandlers()

    db.run(sql`
      INSERT INTO calendar_sources (
        id, provider, kind, account_id, remote_id, title, timezone,
        is_selected, sync_status, last_error, created_at, modified_at
      ) VALUES (
        ${'google-calendar:work'}, ${'google'}, ${'calendar'},
        ${'alice@example.com'}, ${'work@cal'}, ${'Work'}, ${'UTC'},
        ${1}, ${'error'}, ${'token expired'},
        ${'2026-04-15T10:00:00.000Z'}, ${'2026-04-15T10:00:00.000Z'}
      )
    `)

    mockSyncGoogleCalendarSource.mockImplementation(async (db, sourceId) => {
      // Simulate a successful sync clearing the error.
      db.run(sql`
        UPDATE calendar_sources
        SET sync_status = ${'ok'}, last_error = NULL, last_synced_at = ${'2026-04-19T10:00:00.000Z'}
        WHERE id = ${sourceId}
      `)
    })

    const result = await invokeHandler(CalendarChannels.invoke.RETRY_GOOGLE_CALENDAR_SOURCE_SYNC, {
      sourceId: 'google-calendar:work'
    })

    expect(mockSyncGoogleCalendarSource).toHaveBeenCalledWith(
      expect.anything(),
      'google-calendar:work'
    )
    expect(result.success).toBe(true)
    expect(result.source).toEqual(
      expect.objectContaining({
        id: 'google-calendar:work',
        syncStatus: 'ok',
        lastError: null,
        lastSyncedAt: '2026-04-19T10:00:00.000Z'
      })
    )
  })

  it('disconnects only the requested accountId, leaving other accounts intact (M6 T5)', async () => {
    registerCalendarHandlers()

    db.run(sql`
      INSERT INTO calendar_sources (
        id, provider, kind, account_id, remote_id, title, timezone,
        is_selected, sync_status, metadata, created_at, modified_at
      ) VALUES
        (${'google-account:alice@example.com'}, ${'google'}, ${'account'},
         ${'alice@example.com'}, ${'alice@example.com'}, ${'Alice'}, ${'UTC'},
         ${0}, ${'ok'}, ${JSON.stringify({ email: 'alice@example.com' })},
         ${'2026-04-15T10:00:00.000Z'}, ${'2026-04-15T10:00:00.000Z'}),
        (${'google-calendar:alice-primary'}, ${'google'}, ${'calendar'},
         ${'alice@example.com'}, ${'alice@cal'}, ${'Alice Cal'}, ${'UTC'},
         ${1}, ${'ok'}, ${null},
         ${'2026-04-15T10:00:00.000Z'}, ${'2026-04-15T10:00:00.000Z'}),
        (${'google-account:bob@example.com'}, ${'google'}, ${'account'},
         ${'bob@example.com'}, ${'bob@example.com'}, ${'Bob'}, ${'UTC'},
         ${0}, ${'ok'}, ${JSON.stringify({ email: 'bob@example.com' })},
         ${'2026-04-15T10:00:00.000Z'}, ${'2026-04-15T10:00:00.000Z'}),
        (${'google-calendar:bob-primary'}, ${'google'}, ${'calendar'},
         ${'bob@example.com'}, ${'bob@cal'}, ${'Bob Cal'}, ${'UTC'},
         ${1}, ${'ok'}, ${null},
         ${'2026-04-15T10:00:00.000Z'}, ${'2026-04-15T10:00:00.000Z'})
    `)

    mockHasAnyGoogleCalendarLocalAuth.mockResolvedValue(true)
    mockHasGoogleCalendarLocalAuth.mockResolvedValue(true)
    mockListGoogleAccountIds.mockReturnValue(['alice@example.com', 'bob@example.com'])

    const result = await invokeHandler(CalendarChannels.invoke.DISCONNECT_PROVIDER, {
      provider: 'google',
      accountId: 'alice@example.com'
    })

    expect(result.success).toBe(true)
    expect(mockDisconnectGoogleCalendar).toHaveBeenCalledTimes(1)
    expect(mockDisconnectGoogleCalendar).toHaveBeenCalledWith('alice@example.com')

    const sources = await invokeHandler(CalendarChannels.invoke.LIST_SOURCES, {
      provider: 'google'
    })
    const sourceIds = sources.sources.map((s: { id: string }) => s.id)
    // Alice's rows tombstoned (filtered out by listCalendarSources via archivedAt);
    // Bob's rows still active.
    expect(sourceIds).not.toContain('google-account:alice@example.com')
    expect(sourceIds).not.toContain('google-calendar:alice-primary')
    expect(sourceIds).toContain('google-account:bob@example.com')
    expect(sourceIds).toContain('google-calendar:bob-primary')
  })

  it('reconnects an account that was disconnected, reviving its tombstoned rows (#1201)', async () => {
    registerCalendarHandlers()

    const connection = {
      accountId: 'adam@example.com',
      account: {
        remoteId: 'adam@example.com',
        email: 'adam@example.com',
        title: 'Adam Example',
        timezone: 'Europe/London'
      },
      primaryCalendar: {
        remoteId: 'adam@example.com',
        title: 'Adam Example',
        timezone: 'Europe/London',
        color: '#0ea5e9',
        isPrimary: true
      }
    }
    mockConnectGoogleCalendar.mockResolvedValue(connection)
    mockHasAnyGoogleCalendarLocalAuth.mockResolvedValue(true)
    mockHasGoogleCalendarLocalAuth.mockResolvedValue(true)
    mockListGoogleAccountIds.mockReturnValue(['adam@example.com'])
    // Isolate the account + primary rows this test asserts on; discovery has
    // its own coverage and an earlier test leaves an implementation behind.
    mockDiscoverGoogleCalendarSources.mockReset()

    await invokeHandler(CalendarChannels.invoke.CONNECT_PROVIDER, { provider: 'google' })

    // Per-account disconnect — the button the settings UI actually wires up.
    // It tombstones the rows rather than deleting them.
    mockHasAnyGoogleCalendarLocalAuth.mockResolvedValue(false)
    mockHasGoogleCalendarLocalAuth.mockResolvedValue(false)
    const disconnected = await invokeHandler(CalendarChannels.invoke.DISCONNECT_PROVIDER, {
      provider: 'google',
      accountId: 'adam@example.com'
    })
    expect(disconnected.status.connected).toBe(false)

    // Reconnecting the same account must bring it back. Before the fix the
    // upsert left `archived_at` set, so every read path kept filtering the
    // account row out and the user could never connect again.
    mockHasAnyGoogleCalendarLocalAuth.mockResolvedValue(true)
    mockHasGoogleCalendarLocalAuth.mockResolvedValue(true)
    const reconnected = await invokeHandler(CalendarChannels.invoke.CONNECT_PROVIDER, {
      provider: 'google'
    })

    expect(reconnected.success).toBe(true)
    expect(reconnected.status.connected).toBe(true)
    expect(reconnected.status.account).toEqual({
      id: 'google-account:adam@example.com',
      title: 'Adam Example'
    })
    expect(reconnected.status.accounts).toEqual([
      expect.objectContaining({ accountId: 'adam@example.com', status: 'connected' })
    ])
    expect(reconnected.status.calendars.selected).toBe(1)

    const sources = await invokeHandler(CalendarChannels.invoke.LIST_SOURCES, {
      provider: 'google'
    })
    expect(sources.sources.map((source: { id: string }) => source.id)).toEqual([
      'google-account:adam@example.com',
      'google-calendar:adam@example.com'
    ])
    for (const source of sources.sources as Array<{ archivedAt: string | null }>) {
      expect(source.archivedAt).toBeNull()
    }
  })

  it('refreshes Google provider state only when local auth exists', async () => {
    registerCalendarHandlers()
    mockHasAnyGoogleCalendarLocalAuth.mockResolvedValue(false)

    const withoutAuth = await invokeHandler(CalendarChannels.invoke.REFRESH_PROVIDER, {
      provider: 'google'
    })

    expect(withoutAuth).toEqual({
      success: false,
      status: {
        provider: 'google',
        capabilities: GOOGLE_PROVIDER_CAPABILITIES,
        connected: false,
        hasLocalAuth: false,
        account: null,
        accounts: [],
        calendars: {
          total: 0,
          selected: 0,
          memryManaged: 0
        },
        lastSyncedAt: null
      },
      error: 'Google Calendar is not connected on this device'
    })
    expect(mockSyncGoogleCalendarNow).not.toHaveBeenCalled()

    db.run(sql`
      INSERT INTO calendar_sources (
        id,
        provider,
        kind,
        account_id,
        remote_id,
        title,
        timezone,
        is_selected,
        sync_status,
        created_at,
        modified_at
      )
      VALUES (
        ${'google-account-1'},
        ${'google'},
        ${'account'},
        ${null},
        ${'remote-account-1'},
        ${'User Example'},
        ${'UTC'},
        ${0},
        ${'ok'},
        ${'2026-04-12T08:00:00.000Z'},
        ${'2026-04-12T08:00:00.000Z'}
      )
    `)

    mockHasAnyGoogleCalendarLocalAuth.mockResolvedValue(true)
    mockSyncGoogleCalendarNow.mockResolvedValue(undefined)

    const refreshed = await invokeHandler(CalendarChannels.invoke.REFRESH_PROVIDER, {
      provider: 'google'
    })

    expect(refreshed).toEqual({
      success: true,
      status: {
        provider: 'google',
        capabilities: GOOGLE_PROVIDER_CAPABILITIES,
        connected: true,
        hasLocalAuth: true,
        account: {
          id: 'google-account-1',
          title: 'User Example'
        },
        accounts: [],
        calendars: {
          total: 0,
          selected: 0,
          memryManaged: 0
        },
        lastSyncedAt: null
      }
    })
    expect(mockSyncGoogleCalendarNow).toHaveBeenCalledWith(expect.anything())
    expect(webContentsSend).toHaveBeenCalledWith(CalendarChannels.events.CHANGED, {
      entityType: 'projection',
      id: 'google-refresh'
    })
  })

  it('returns a title search hit in the lean shape, without the record fields (#869)', async () => {
    // #given — one event created through the real handler
    registerCalendarHandlers()
    await invokeHandler(CalendarChannels.invoke.CREATE_EVENT, {
      title: 'Quarterly planning',
      description: 'Align roadmap',
      location: 'Studio',
      startAt: '2026-04-12T09:00:00.000Z',
      endAt: '2026-04-12T10:00:00.000Z',
      timezone: 'UTC',
      isAllDay: false
    })

    // #when — we search for a title substring
    const found = await invokeHandler(CalendarChannels.invoke.SEARCH_EVENTS, {
      query: 'quarterly'
    })

    // #then — the lean shape comes back, without the record's heavy fields
    expect(found.events).toEqual([
      {
        id: 'calendar-event-generated-id',
        title: 'Quarterly planning',
        startAt: '2026-04-12T09:00:00.000Z',
        endAt: '2026-04-12T10:00:00.000Z',
        isAllDay: false
      }
    ])
    expect(found.events[0]).not.toHaveProperty('attendees')
    expect(found.events[0]).not.toHaveProperty('description')
  })

  it('rejects an empty search query at the schema boundary (#869)', async () => {
    // #given — registered handlers
    registerCalendarHandlers()

    // #when / #then — an empty query never reaches the database
    await expect(
      invokeHandler(CalendarChannels.invoke.SEARCH_EVENTS, { query: '' })
    ).rejects.toThrow(/Validation failed/)
  })

  it('returns no matches for an unrelated query (#869)', async () => {
    // #given — one event
    registerCalendarHandlers()
    await invokeHandler(CalendarChannels.invoke.CREATE_EVENT, {
      title: 'Quarterly planning',
      startAt: '2026-04-12T09:00:00.000Z',
      timezone: 'UTC',
      isAllDay: false
    })

    // #when — we search for something else
    const found = await invokeHandler(CalendarChannels.invoke.SEARCH_EVENTS, { query: 'retro' })

    // #then — an empty list, not an error
    expect(found.events).toEqual([])
  })

  describe('provider registry (#1392)', () => {
    it('reports the providers this build can connect, with their capabilities', async () => {
      registerCalendarHandlers()

      const listed = await invokeHandler(CalendarChannels.invoke.LIST_PROVIDERS)

      expect(listed).toEqual({
        providers: [{ id: 'google', capabilities: GOOGLE_PROVIDER_CAPABILITIES }]
      })
    })

    it.each([
      CalendarChannels.invoke.CONNECT_PROVIDER,
      CalendarChannels.invoke.DISCONNECT_PROVIDER,
      CalendarChannels.invoke.REFRESH_PROVIDER
    ])('rejects an unregistered provider on %s with the historical message', async (channel) => {
      registerCalendarHandlers()

      const result = await invokeHandler(channel, { provider: 'caldav' })

      // Byte-identical to the string the four `!== 'google'` guards returned.
      expect(result.success).toBe(false)
      expect(result.error).toBe('Unsupported calendar provider: caldav')
      // …and it reports the unknown provider's status rather than throwing,
      // with null capabilities because this build does not know it.
      expect(result.status).toMatchObject({ provider: 'caldav', capabilities: null })
    })

    it('never runs a provider flow for an unregistered provider', async () => {
      registerCalendarHandlers()

      await invokeHandler(CalendarChannels.invoke.CONNECT_PROVIDER, { provider: 'ics' })

      expect(mockConnectGoogleCalendar).not.toHaveBeenCalled()
      expect(mockStartGoogleCalendarSyncRunner).not.toHaveBeenCalled()
    })

    describe('legacy channels are permanent aliases', () => {
      // An older renderer talking to a newer main still sends these. Deleting
      // one breaks the app for the length of a partial update, so they are a
      // compatibility surface, not dead code.
      it('calendar:list-google-calendars resolves to the google provider', async () => {
        registerCalendarHandlers()
        mockResolveDefaultGoogleAccountId.mockReturnValue('user@example.com')

        const legacy = await invokeHandler(CalendarChannels.invoke.LIST_GOOGLE_CALENDARS, {})
        const generic = await invokeHandler(CalendarChannels.invoke.LIST_PROVIDER_CALENDARS, {
          provider: 'google'
        })

        expect(legacy).toEqual(generic)
        expect(mockListGoogleCalendars).toHaveBeenCalledTimes(2)
      })

      it('calendar:set-default-google-calendar resolves to the google provider', async () => {
        registerCalendarHandlers()

        const legacy = await invokeHandler(CalendarChannels.invoke.SET_DEFAULT_GOOGLE_CALENDAR, {
          calendarId: 'cal-1',
          markOnboardingComplete: true
        })

        expect(legacy).toMatchObject({ success: true })
        expect(mockSetDefaultGoogleCalendar).toHaveBeenCalledWith(expect.anything(), {
          calendarId: 'cal-1',
          markOnboardingComplete: true
        })
      })

      it('calendar:retry-google-source-sync and calendar:retry-source-sync share one handler', async () => {
        registerCalendarHandlers()
        db.run(sql`
          INSERT INTO calendar_sources (
            id, provider, kind, account_id, remote_id, title, timezone,
            is_selected, sync_status, created_at, modified_at
          ) VALUES (
            ${'google-calendar-1'}, ${'google'}, ${'calendar'},
            ${'user@example.com'}, ${'primary'}, ${'Primary'}, ${'UTC'},
            ${1}, ${'ok'}, ${'2026-04-12T08:00:00.000Z'}, ${'2026-04-12T08:00:00.000Z'}
          )
        `)

        const legacy = await invokeHandler(
          CalendarChannels.invoke.RETRY_GOOGLE_CALENDAR_SOURCE_SYNC,
          { sourceId: 'google-calendar-1' }
        )
        const generic = await invokeHandler(CalendarChannels.invoke.RETRY_SOURCE_SYNC, {
          sourceId: 'google-calendar-1'
        })

        expect(legacy.success).toBe(true)
        expect(generic.success).toBe(true)
        expect(mockSyncGoogleCalendarSource).toHaveBeenCalledTimes(2)
      })

      it('unregisters every channel it registered, legacy included', () => {
        registerCalendarHandlers()
        const registered = handleCalls.map(([channel]) => channel as string)

        unregisterCalendarHandlers()

        expect(removeHandlerCalls).toEqual(expect.arrayContaining(registered))
      })
    })
  })
})
