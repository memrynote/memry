import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { sql } from 'drizzle-orm'
import { mockIpcMain, resetIpcMocks, invokeHandler } from '@tests/utils/mock-ipc'
import {
  createTestDataDb,
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
const mockSyncGoogleCalendarNow = vi.fn()
const mockSyncGoogleCalendarSource = vi.fn()
const mockStartGoogleCalendarSyncRunner = vi.fn(async () => {})
const mockStopGoogleCalendarSyncRunner = vi.fn()
const mockIsMemryUserSignedIn = vi.fn(async () => true)

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
    getAllWindows: vi.fn(() => [{ webContents: { send: webContentsSend } }])
  }
}))

vi.mock('../database', () => ({
  getDatabase: vi.fn(),
  requireDatabase: vi.fn()
}))

vi.mock('../lib/id', () => ({
  generateId: vi.fn(() => 'calendar-event-generated-id')
}))

vi.mock('../sync/local-mutations', () => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn()
}))

vi.mock('../calendar/google/oauth', () => ({
  connectGoogleCalendar: (...args: unknown[]) => mockConnectGoogleCalendar(...args),
  disconnectGoogleCalendar: (...args: unknown[]) => mockDisconnectGoogleCalendar(...args),
  hasGoogleCalendarLocalAuth: (...args: unknown[]) => mockHasGoogleCalendarLocalAuth(...args),
  hasAnyGoogleCalendarLocalAuth: (...args: unknown[]) => mockHasAnyGoogleCalendarLocalAuth(...args),
  listGoogleAccountIds: (...args: unknown[]) => mockListGoogleAccountIds(...args),
  resolveDefaultGoogleAccountId: (...args: unknown[]) => mockResolveDefaultGoogleAccountId(...args)
}))

vi.mock('../calendar/google/sync-service', () => ({
  syncGoogleCalendarNow: (...args: unknown[]) => mockSyncGoogleCalendarNow(...args),
  syncGoogleCalendarSource: (...args: unknown[]) => mockSyncGoogleCalendarSource(...args),
  startGoogleCalendarSyncRunner: (...args: unknown[]) => mockStartGoogleCalendarSyncRunner(...args),
  stopGoogleCalendarSyncRunner: (...args: unknown[]) => mockStopGoogleCalendarSyncRunner(...args)
}))

vi.mock('../auth-state', () => ({
  isMemryUserSignedIn: (...args: unknown[]) => mockIsMemryUserSignedIn(...args)
}))

import { getDatabase, requireDatabase } from '../database'
import {
  enqueueLocalSyncCreate,
  enqueueLocalSyncDelete,
  enqueueLocalSyncUpdate
} from '../sync/local-mutations'
import { registerCalendarHandlers, unregisterCalendarHandlers } from './calendar-handlers'

describe('calendar-handlers', () => {
  let dbResult: TestDatabaseResult
  let db: TestDb

  beforeEach(() => {
    resetIpcMocks()
    vi.clearAllMocks()
    handleCalls.length = 0
    removeHandlerCalls.length = 0
    dbResult = createTestDataDb()
    db = dbResult.db
    ;(getDatabase as Mock).mockReturnValue(asClientDb(db))
    ;(requireDatabase as Mock).mockReturnValue(asClientDb(db))
    mockHasGoogleCalendarLocalAuth.mockResolvedValue(false)
    mockHasAnyGoogleCalendarLocalAuth.mockResolvedValue(false)
    mockListGoogleAccountIds.mockReturnValue([])
    mockResolveDefaultGoogleAccountId.mockReturnValue(null)
    mockDisconnectGoogleCalendar.mockResolvedValue(undefined)
  })

  afterEach(() => {
    unregisterCalendarHandlers()
    dbResult.close()
  })

  it('registers all calendar handlers', () => {
    registerCalendarHandlers()
    expect(handleCalls.length).toBe(Object.values(CalendarChannels.invoke).length)
  })

  it('creates, updates, deletes, and lists Memry events', async () => {
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

  it('returns projected range items for Memry and imported provider events', async () => {
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
          status: 'disconnected',
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
})
