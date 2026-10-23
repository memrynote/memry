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
vi.mock('../../store', () => ({ getCurrentVaultPath: () => null, setStoredLocale: vi.fn() }))
vi.mock('../../vault/settings-cache', () => ({ writeCacheFromPreferences: vi.fn() }))
vi.mock('../../tray', () => ({ applyTraySetting: vi.fn() }))
vi.mock('../../ipc/locale-handler', () => ({ applyLocale: vi.fn(() => Promise.resolve()) }))
vi.mock('../../database', () => ({ getDatabase: vi.fn() }))
const release = vi.hoisted(() => vi.fn(() => Promise.resolve(false)))
vi.mock('../../readwise/release', () => ({ releaseTokenIfClaimedElsewhere: release }))

import { getDatabase } from '../../database'
import { getSetting, setSetting } from '../../database/queries/settings'
import {
  createTestDatabase,
  cleanupTestDatabase,
  asClientDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { settingsHandler } from './settings-handler'

describe('settingsHandler: readwise group', () => {
  const ctx: ApplyContext = { db: {} as unknown as DrizzleDb, emit: vi.fn() }
  const clock: VectorClock = { 'device-B': 3 }
  let testDb: TestDatabaseResult

  beforeEach(() => {
    testDb = createTestDatabase()
    vi.mocked(getDatabase).mockReturnValue(asClientDb(testDb.db))
  })
  afterEach(() => {
    cleanupTestDatabase(testDb)
  })

  it('merges a remote readwise group into the local row, keeping local and unknown fields', () => {
    setSetting(
      getDatabase(),
      'readwise',
      JSON.stringify({ cadence: 'daily', categories: { books: false } })
    )
    const readwise = {
      folderLayout: 'flat',
      syncDeviceId: 'device-B',
      categories: { tweets: false }
    }
    mockGetSettings.mockReturnValue({ readwise })

    const data = { settings: { readwise }, fieldClocks: {} } as SettingsSyncPayload
    expect(settingsHandler.applyUpsert(ctx, 'synced_settings', data, clock)).toBe('applied')

    expect(JSON.parse(getSetting(getDatabase(), 'readwise') ?? '{}')).toEqual({
      cadence: 'daily',
      folderLayout: 'flat',
      syncDeviceId: 'device-B',
      categories: { books: false, tweets: false }
    })
  })

  it('hands a merged group to the old device so it can drop its token after a takeover (D8)', () => {
    const readwise = { syncDeviceId: 'device-B', syncDeviceName: 'Laptop' }
    mockGetSettings.mockReturnValue({ readwise })
    const data = { settings: { readwise }, fieldClocks: {} } as SettingsSyncPayload

    expect(settingsHandler.applyUpsert(ctx, 'synced_settings', data, clock)).toBe('applied')

    expect(release).toHaveBeenCalledTimes(1)
  })
})
