import { beforeEach, describe, expect, it, vi } from 'vitest'
import keytar from 'keytar'
import { CALDAV_PRESETS, caldavPresetServerUrl } from '@memry/contracts/caldav-presets'
import { createTestDataDb } from '@tests/utils/test-db'
import { FakeCaldavServer } from '@tests/utils/fake-caldav-server'
import type { DataDb } from '../../database'
import { registerBuiltinCalendarProviders } from '../provider/builtin-providers'
import { buildProviderStatus } from '../provider/status'
import { setCaldavAuthFailure } from './caldav-accounts'
import { connectCaldavAccount, discoverCaldavCalendars } from './caldav-connect'

vi.mock('keytar', () => ({
  default: { setPassword: vi.fn(), getPassword: vi.fn(), deletePassword: vi.fn() }
}))
vi.mock('../change-events', () => ({
  emitCalendarChanged: vi.fn(),
  emitCalendarProjectionChanged: vi.fn()
}))
vi.mock('../../sync/local-mutations', () => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn()
}))

const secrets = new Map<string, string>()

beforeEach(() => {
  secrets.clear()
  vi.mocked(keytar.setPassword).mockImplementation(async (service, account, value) => {
    secrets.set(`${service}:${account}`, value)
  })
  vi.mocked(keytar.getPassword).mockImplementation(
    async (service, account) => secrets.get(`${service}:${account}`) ?? null
  )
  vi.mocked(keytar.deletePassword).mockImplementation(async (service, account) =>
    secrets.delete(`${service}:${account}`)
  )
})

describe('discovery smoke test per preset (#1401)', () => {
  it.each(CALDAV_PRESETS.map((preset) => [preset.id, preset] as const))(
    '%s discovers its calendars',
    async (_id, preset) => {
      const typed = preset.hostTemplate ? 'cloud.example.com' : 'https://dav.example.com:5232/'
      const serverUrl = caldavPresetServerUrl(preset, typed)
      const url = new URL(serverUrl)
      const server = new FakeCaldavServer({
        host: url.hostname,
        partitionHost: preset.id === 'icloud' ? 'p42-caldav.icloud.com' : undefined,
        username: 'me',
        password: 'app-password',
        calendars: [{ path: '/me/calendars/personal/', displayName: 'Personal' }]
      })

      const info = await discoverCaldavCalendars(
        { serverUrl, username: 'me', password: 'app-password' },
        { fetchImpl: server.fetch }
      )

      expect(info.calendars.map((calendar) => calendar.displayName)).toEqual(['Personal'])
      if (preset.id === 'nextcloud')
        expect(serverUrl).toBe('https://cloud.example.com/remote.php/dav/')
      if (preset.id === 'icloud') {
        expect(info.calendars[0].url).toBe('https://p42-caldav.icloud.com/me/calendars/personal/')
      }
    }
  )
})

describe('reconnect_required (#1401)', () => {
  it('reports why an account needs its password again on this device', async () => {
    registerBuiltinCalendarProviders()
    const { db: testDb, close } = createTestDataDb()
    const db = testDb as unknown as DataDb
    const server = new FakeCaldavServer({
      host: 'caldav.icloud.com',
      username: 'me@icloud.com',
      password: 'app-password',
      calendars: [{ path: '/me/calendars/home/', displayName: 'Home' }]
    })
    const { accountId } = await connectCaldavAccount(
      db,
      {
        serverUrl: 'https://caldav.icloud.com/',
        username: 'me@icloud.com',
        password: 'app-password',
        preset: 'icloud'
      },
      { fetchImpl: server.fetch }
    )

    expect((await buildProviderStatus(db, 'caldav')).accounts[0]).toMatchObject({
      accountId,
      status: 'connected',
      serverUrl: 'https://caldav.icloud.com/',
      username: 'me@icloud.com',
      preset: 'icloud'
    })

    // The server rejected the app password (an Apple ID reset revokes them all).
    setCaldavAuthFailure(db, accountId, true)
    expect((await buildProviderStatus(db, 'caldav')).accounts[0]).toMatchObject({
      status: 'reconnect_required',
      reconnectReason: 'rejected'
    })

    // Another device: the synced rows arrive, the password does not.
    setCaldavAuthFailure(db, accountId, false)
    secrets.clear()
    const status = await buildProviderStatus(db, 'caldav')
    expect(status.accounts[0]).toMatchObject({
      status: 'reconnect_required',
      reconnectReason: 'missing'
    })
    expect(JSON.stringify(status)).not.toContain('app-password')
    close()
  })
})
