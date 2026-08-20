import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SettingsSyncPayload } from '@memry/contracts/settings-sync'
import type { VectorClock } from '@memry/contracts/sync-api'
import type { ApplyContext, DrizzleDb } from './types'

const mockMergeRemote = vi.fn()
const mockGetSettings = vi.fn(() => ({}))
// The outbound half of SettingsSyncManager. Applying an inbound settings item
// must never touch these — updateField()/enqueue*() are the only things that
// push a settings item, so a call here is an echo back to the sending device.
const mockUpdateField = vi.fn()
const mockEnqueueCreate = vi.fn()
const mockEnqueueUpdate = vi.fn()
const mockEnqueueDelete = vi.fn()
vi.mock('../settings-sync', () => ({
  getSettingsSyncManager: vi.fn(() => ({
    mergeRemote: mockMergeRemote,
    getSettings: mockGetSettings,
    updateField: mockUpdateField,
    enqueueCreate: mockEnqueueCreate,
    enqueueUpdate: mockEnqueueUpdate,
    enqueueDelete: mockEnqueueDelete
  }))
}))

const mockWritePreferences = vi.fn()
vi.mock('../../vault/vault-preferences', () => ({
  writePreferences: (...args: unknown[]) => mockWritePreferences(...args)
}))

const mockWriteCacheFromPreferences = vi.fn()
const mockReadPreferences = vi.fn(() => ({
  theme: 'dark',
  fontSize: 'medium',
  fontFamily: 'system',
  accentColor: '#6366f1',
  language: 'en',
  createInSelectedFolder: true,
  editor: {
    width: 'medium',
    toolbarMode: 'floating'
  }
}))
vi.mock('../../vault/settings-cache', () => ({
  writeCacheFromPreferences: (...args: unknown[]) => mockWriteCacheFromPreferences(...args)
}))
vi.mock('../../vault/vault-preferences', () => ({
  writePreferences: (...args: unknown[]) => mockWritePreferences(...args),
  readPreferences: () => mockReadPreferences()
}))

const mockGetCurrentVaultPath = vi.fn(() => '/test/vault')
const mockSetStoredLocale = vi.fn()
vi.mock('../../store', () => ({
  getCurrentVaultPath: () => mockGetCurrentVaultPath(),
  setStoredLocale: (...args: unknown[]) => mockSetStoredLocale(...args)
}))

const mockSend = vi.fn()
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => [{ isDestroyed: () => false, webContents: { send: mockSend } }])
  },
  // locale-handler registers its IPC channels on import-time registration; the
  // real apply path is exercised through it, so ipcMain has to exist.
  ipcMain: { handle: vi.fn() }
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

describe('settingsHandler — journal template settings', () => {
  const ctx: ApplyContext = {
    db: {} as unknown as DrizzleDb,
    emit: vi.fn()
  }
  const clock: VectorClock = { 'device-B': 3 }
  let testDb: TestDatabaseResult

  beforeEach(() => {
    vi.clearAllMocks()
    testDb = createTestDatabase()
    vi.mocked(getDatabase).mockReturnValue(asClientDb(testDb.db))
    mockGetCurrentVaultPath.mockReturnValue('/test/vault')
  })

  afterEach(() => {
    cleanupTestDatabase(testDb)
  })

  const applyJournal = (journal: Record<string, unknown>) => {
    mockGetSettings.mockReturnValue({ journal })
    const data: SettingsSyncPayload = {
      settings: { journal },
      fieldClocks: {}
    } as SettingsSyncPayload
    return settingsHandler.applyUpsert(ctx, 'synced_settings', data, clock)
  }

  const storedMap = (): Record<string, string | null> => {
    const raw = getSetting(getDatabase(), 'journal.weekdayTemplates')
    return raw ? JSON.parse(raw) : {}
  }

  const journalBroadcasts = () =>
    mockSend.mock.calls.filter(
      ([channel, payload]) =>
        channel === SettingsChannels.events.CHANGED && payload?.key === 'journal'
    )

  it('writes an inbound default template to the local flat setting', () => {
    applyJournal({ defaultTemplate: 'morning-pages' })
    expect(getSetting(getDatabase(), 'journal.defaultTemplate')).toBe('morning-pages')
  })

  it('clears the local default template when the inbound value is null', () => {
    setSetting(getDatabase(), 'journal.defaultTemplate', 'morning-pages')
    applyJournal({ defaultTemplate: null })
    expect(getSetting(getDatabase(), 'journal.defaultTemplate')).toBeNull()
  })

  it('merges the inbound weekday map over the local one instead of replacing it', () => {
    // Wednesday was set on this device before settings sync covered the group,
    // so it has no clock and never left the machine. Replacing the whole map
    // with the synced subset would silently drop it.
    setSetting(getDatabase(), 'journal.weekdayTemplates', JSON.stringify({ '3': 'local-only' }))

    applyJournal({ weekdayTemplates: { '1': 'daily-standup' } })

    expect(storedMap()).toEqual({ '1': 'daily-standup', '3': 'local-only' })
  })

  it('applies an inbound cleared day', () => {
    setSetting(getDatabase(), 'journal.weekdayTemplates', JSON.stringify({ '1': 'daily-standup' }))
    applyJournal({ weekdayTemplates: { '1': null } })
    expect(storedMap()).toEqual({ '1': null })
  })

  it('ignores inbound keys outside 0..6 rather than failing the item', () => {
    const result = applyJournal({ weekdayTemplates: { '1': 'daily-standup', '99': 'nope' } })
    expect(result).toBe('applied')
    expect(storedMap()).toEqual({ '1': 'daily-standup' })
  })

  it('broadcasts the merged map so open windows update without a restart', () => {
    setSetting(getDatabase(), 'journal.weekdayTemplates', JSON.stringify({ '3': 'local-only' }))

    applyJournal({ weekdayTemplates: { '1': 'daily-standup' } })

    const [, payload] = journalBroadcasts().at(-1) ?? []
    // The DB-authoritative merge, not the synced subset: the renderer patches
    // settings shallowly, so broadcasting the subset would drop the local day.
    expect(payload.value.weekdayTemplates).toEqual({
      '1': 'daily-standup',
      '3': 'local-only'
    })
  })

  it('does not broadcast a journal change when the payload carries no journal group', () => {
    mockGetSettings.mockReturnValue({ general: { theme: 'dark' } })
    settingsHandler.applyUpsert(
      ctx,
      'synced_settings',
      { settings: { general: { theme: 'dark' } }, fieldClocks: {} } as SettingsSyncPayload,
      clock
    )
    expect(journalBroadcasts()).toHaveLength(0)
  })
})
