import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { sql } from 'drizzle-orm'
import { mockIpcMain, resetIpcMocks, invokeHandler } from '@tests/utils/mock-ipc'
import { createTestDataDb, type TestDatabaseResult, type TestDb, asClientDb } from '@tests/utils/test-db'
import { CalendarChannels } from '@memry/contracts/ipc-channels'

const handleCalls: unknown[][] = []
const removeHandlerCalls: string[] = []
const webContentsSend = vi.fn()
const mockConnectGoogleCalendar = vi.fn()
const mockDisconnectGoogleCalendar = vi.fn()
const mockHasGoogleCalendarLocalAuth = vi.fn()
const mockSyncGoogleCalendarNow = vi.fn()

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
  hasGoogleCalendarLocalAuth: (...args: unknown[]) => mockHasGoogleCalendarLocalAuth(...args)
}))

vi.mock('../calendar/google/sync-service', () => ({
  syncGoogleCalendarNow: (...args: unknown[]) => mockSyncGoogleCalendarNow(...args)
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
      'calendar-event-generated-id'
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
      account: {
        remoteId: 'user@example.com',
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
    mockHasGoogleCalendarLocalAuth.mockResolvedValue(true)

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

    mockHasGoogleCalendarLocalAuth.mockResolvedValue(false)

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

  it('refreshes Google provider state only when local auth exists', async () => {
    registerCalendarHandlers()
    mockHasGoogleCalendarLocalAuth.mockResolvedValue(false)

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

    mockHasGoogleCalendarLocalAuth.mockResolvedValue(true)
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
