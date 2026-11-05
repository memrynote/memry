import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from '@memry/db-schema/data-schema'

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  watchCalendar: vi.fn(),
  stopChannel: vi.fn(),
  db: { current: undefined } as { current: unknown }
}))

vi.mock('electron', () => ({
  net: { fetch: (...args: unknown[]) => mocks.fetch(...args) }
}))

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

vi.mock('../../lib/main-i18n', () => ({
  getMainI18n: () => ({ t: (key: string) => key, getFixedT: () => (key: string) => key })
}))

vi.mock('../../sync/token-manager', () => ({
  getValidAccessToken: async () => 'token-1'
}))

vi.mock('./oauth', () => ({
  resolveDefaultGoogleAccountId: () => 'account-1'
}))

vi.mock('./client', () => ({
  createGoogleCalendarClient: () => ({
    watchCalendar: mocks.watchCalendar,
    stopChannel: mocks.stopChannel
  })
}))

vi.mock('../repositories/calendar-sources-repository', () => ({
  getCalendarSourceById: () => ({ accountId: 'account-1' })
}))

vi.mock('../../database', () => ({
  requireDatabase: () => mocks.db.current,
  getDatabase: () => mocks.db.current
}))

import {
  __testing_resetGooglePushRuntime,
  getOrInitGooglePushRuntime,
  type CalendarSourceLite
} from './push-runtime'

const SOURCE: CalendarSourceLite = {
  id: 'google-calendar:holidays',
  remoteId: 'holidays',
  isMemryManaged: false
}

const serverCalls = (method: string): unknown[][] =>
  mocks.fetch.mock.calls.filter(([, init]) => (init as { method: string }).method === method)

describe('Google push channel registration through the real HTTP client', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('SYNC_SERVER_URL', 'https://sync.example.test')
    vi.stubEnv('CALENDAR_PUSH_ENABLED', '1')
    const sqlite = new Database(':memory:')
    sqlite.exec(
      `CREATE TABLE settings (
         key TEXT PRIMARY KEY,
         value TEXT NOT NULL,
         modified_at TEXT NOT NULL
       )`
    )
    mocks.db.current = drizzle(sqlite, { schema })
    __testing_resetGooglePushRuntime()
    mocks.fetch.mockImplementation(async (_url: string, init: { method: string }) =>
      init.method === 'POST'
        ? new Response(JSON.stringify({ channelId: 'c', expiresAt: 1 }), { status: 201 })
        : new Response(null, { status: 204 })
    )
    mocks.stopChannel.mockResolvedValue(undefined)
  })

  afterEach(() => {
    __testing_resetGooglePushRuntime()
    vi.unstubAllEnvs()
  })

  // #4020: PATCH /calendar/channels/:id answers 204, which syncFetch used to
  // reject, leaving every start with a Google channel and a server row that
  // never got its resourceId.
  it('finishes registering a channel when the server answers the resourceId PATCH with 204', async () => {
    mocks.watchCalendar.mockResolvedValue({ resourceId: 'resource-1', expiration: 9_999_999_999 })
    const runtime = getOrInitGooglePushRuntime({ onActiveCountChange: vi.fn() })!

    await runtime.ensureForSelectedSources([SOURCE])

    expect(serverCalls('PATCH')).toHaveLength(1)
    expect(runtime.getActiveChannelCount()).toBe(1)
    await runtime.stopAll()
  })

  it('does not watch a calendar Google cannot push for again on the next start', async () => {
    mocks.watchCalendar.mockRejectedValue(
      Object.assign(new Error('googleCalendar.requestFailed'), {
        status: 400,
        apiReason: 'pushNotSupportedForRequestedResource'
      })
    )

    const firstStart = getOrInitGooglePushRuntime({ onActiveCountChange: vi.fn() })!
    await firstStart.ensureForSelectedSources([SOURCE])
    expect(mocks.watchCalendar).toHaveBeenCalledTimes(1)
    expect(serverCalls('DELETE')).toHaveLength(1)

    __testing_resetGooglePushRuntime()
    const secondStart = getOrInitGooglePushRuntime({ onActiveCountChange: vi.fn() })!
    await secondStart.ensureForSelectedSources([SOURCE])

    expect(mocks.watchCalendar).toHaveBeenCalledTimes(1)
    expect(serverCalls('POST')).toHaveLength(1)
    expect(secondStart.getActiveChannelCount()).toBe(0)
  })
})
