import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SettingsSyncPayload } from '@memry/contracts/settings-sync'
import type { VectorClock } from '@memry/contracts/sync-api'
import type { ApplyContext, DrizzleDb } from '@memry/sync-client/item-handlers/types'

const mockGetSettings = vi.fn(() => ({}))
vi.mock('@memry/sync-client/settings-sync', () => ({
  getSettingsSyncManager: vi.fn(() => ({
    mergeRemote: vi.fn(),
    getSettings: mockGetSettings,
    updateField: vi.fn()
  }))
}))

// Features are local-DB-only, so they must land without a resolvable vault path.
vi.mock('../../store', () => ({
  getCurrentVaultPath: () => null,
  setStoredLocale: vi.fn()
}))

vi.mock('../../vault/settings-cache', () => ({
  writeCacheFromPreferences: vi.fn()
}))

vi.mock('../../tray', () => ({
  applyTraySetting: vi.fn()
}))

vi.mock('../../ipc/locale-handler', () => ({
  applyLocale: vi.fn(() => Promise.resolve())
}))

vi.mock('../../database', () => ({
  getDatabase: vi.fn()
}))

import { SettingsChannels } from '@memry/contracts/ipc-channels'
import { getDatabase } from '../../database'
import { getSetting, setSetting } from '../../database/queries/settings'
import {
  createTestDatabase,
  cleanupTestDatabase,
  asClientDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { settingsHandler } from './settings-handler'

describe('settingsHandler — features settings', () => {
  const emit = vi.fn()
  const ctx: ApplyContext = {
    db: {} as unknown as DrizzleDb,
    emit: (channel, data) => emit(channel, data)
  }
  const clock: VectorClock = { 'device-B': 3 }
  let testDb: TestDatabaseResult

  beforeEach(() => {
    vi.clearAllMocks()
    testDb = createTestDatabase()
    vi.mocked(getDatabase).mockReturnValue(asClientDb(testDb.db))
  })

  afterEach(() => {
    cleanupTestDatabase(testDb)
  })

  const applyFeatures = (features: Record<string, unknown>) => {
    mockGetSettings.mockReturnValue({ features })
    const data = { settings: { features }, fieldClocks: {} } as SettingsSyncPayload
    return settingsHandler.applyUpsert(ctx, 'synced_settings', data, clock)
  }

  const storedFeatures = (): Record<string, unknown> =>
    JSON.parse(getSetting(getDatabase(), 'features') ?? '{}')

  const featuresBroadcast = () =>
    emit.mock.calls.find(
      ([channel, payload]) =>
        channel === SettingsChannels.events.CHANGED && payload?.key === 'features'
    )?.[1]

  it('#given a remote flag turned off #then writes it to the local row and tells the renderer', () => {
    setSetting(getDatabase(), 'features', JSON.stringify({ journal: true, graph: false }))

    expect(applyFeatures({ journal: false })).toBe('applied')

    // `false` is a real value, and a flag the merge does not carry stays put.
    expect(storedFeatures()).toEqual({ journal: false, graph: false })
    expect(featuresBroadcast()).toEqual({ key: 'features', value: { journal: false } })
  })

  it('#given no local row yet #then creates it from the remote flags', () => {
    applyFeatures({ tasks: false })

    expect(storedFeatures()).toEqual({ tasks: false })
  })

  it('#given a flag only a newer build knows #then keeps it in the local row', () => {
    applyFeatures({ journal: false, quickSwitcher: false })

    expect(storedFeatures()).toEqual({ journal: false, quickSwitcher: false })
  })

  it('#given a merge without features #then leaves the row alone and announces nothing', () => {
    setSetting(getDatabase(), 'features', JSON.stringify({ journal: false }))
    mockGetSettings.mockReturnValue({ general: { theme: 'light' } })
    const data = {
      settings: { general: { theme: 'light' } },
      fieldClocks: {}
    } as SettingsSyncPayload

    settingsHandler.applyUpsert(ctx, 'synced_settings', data, clock)

    expect(storedFeatures()).toEqual({ journal: false })
    expect(featuresBroadcast()).toBeUndefined()
  })
})
