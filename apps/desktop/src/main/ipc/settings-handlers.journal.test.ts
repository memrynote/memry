/**
 * Journal template settings IPC handler tests.
 *
 * @module ipc/settings-handlers.journal.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createTestDatabase,
  cleanupTestDatabase,
  asClientDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'

const updateField = vi.fn()
vi.mock('../sync/local-mutations', () => ({
  syncSettingsFieldUpdate: (path: string, value: unknown) => updateField(path, value)
}))

// settings-handlers.ts has heavy module-scope imports (electron + several main
// subsystems). Mirror the mocks used by the inbox settings tests so this file
// can import the module directly and exercise the real settings table via an
// in-memory DB.
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    removeHandler: vi.fn(),
    removeAllListeners: vi.fn()
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => [])
  },
  app: {
    setLoginItemSettings: vi.fn(),
    getAppPath: vi.fn(() => '/mock/app'),
    isPackaged: false
  },
  globalShortcut: {
    unregisterAll: vi.fn(),
    unregister: vi.fn(),
    register: vi.fn()
  },
  systemPreferences: {
    isTrustedAccessibilityClient: vi.fn()
  },
  shell: {
    openExternal: vi.fn()
  }
}))

vi.mock('../database', () => ({
  getDatabase: vi.fn(),
  requireDatabase: vi.fn()
}))

vi.mock('../lib/embeddings', () => ({
  initEmbeddingModel: vi.fn(),
  getModelInfo: vi.fn(),
  isModelLoaded: vi.fn(),
  isModelLoading: vi.fn(),
  resetEmbeddingModelFailure: vi.fn()
}))

vi.mock('../projections', () => ({
  rebuildProjections: vi.fn()
}))

vi.mock('../vault/vault-preferences', () => ({
  writePreferences: vi.fn(),
  PORTABLE_GENERAL_FIELDS: [
    'theme',
    'fontSize',
    'fontFamily',
    'accentColor',
    'language',
    'createInSelectedFolder'
  ]
}))

vi.mock('../store', () => ({
  getCurrentVaultPath: vi.fn(() => null),
  getDefaultVaultPath: vi.fn(() => null),
  getVaults: vi.fn(() => []),
  setDefaultVaultPath: vi.fn()
}))

vi.mock('../inbox/voice-model', () => ({
  downloadVoiceModel: vi.fn(),
  getVoiceModelStatus: vi.fn()
}))

vi.mock('../inbox/voice-transcription-settings', () => ({
  getVoiceRecordingReadiness: vi.fn()
}))

vi.mock('../inbox/voice-transcription-keychain', () => ({
  hasVoiceTranscriptionOpenAIApiKey: vi.fn(),
  setVoiceTranscriptionOpenAIApiKey: vi.fn()
}))

vi.mock('../telemetry/track', () => ({
  trackMainEvent: vi.fn()
}))

const broadcast = vi.fn()
vi.mock('../lib/window-broadcast', () => ({
  broadcastToAllWindows: (channel: string, payload: unknown) => broadcast(channel, payload)
}))

import { getDatabase } from '../database'
import { getSetting, setSetting } from '../database/queries/settings'
import { getJournalSettings, writeJournalSettings } from './settings-handlers'

const WEEKDAY_KEY = 'journal.weekdayTemplates'

function storedMap(): Record<string, string | null> {
  const raw = getSetting(getDatabase(), WEEKDAY_KEY)
  return raw ? JSON.parse(raw) : {}
}

function lastJournalBroadcast(): Record<string, unknown> | undefined {
  const calls = broadcast.mock.calls.filter(([, payload]) => payload?.key === 'journal')
  return calls.at(-1)?.[1]?.value
}

describe('journal template settings handler', () => {
  let testDb: TestDatabaseResult

  beforeEach(() => {
    updateField.mockClear()
    broadcast.mockClear()
    testDb = createTestDatabase()
    vi.mocked(getDatabase).mockReturnValue(asClientDb(testDb.db))
  })

  afterEach(() => {
    cleanupTestDatabase(testDb)
  })

  it('defaults to an empty weekday map', () => {
    expect(getJournalSettings().weekdayTemplates).toEqual({})
  })

  it('reads settings written before weekday templates existed', () => {
    // The pre-upgrade shape: a default template row and no weekday row at all.
    setSetting(getDatabase(), 'journal.defaultTemplate', 'morning-pages')
    expect(getJournalSettings()).toMatchObject({
      defaultTemplate: 'morning-pages',
      weekdayTemplates: {}
    })
  })

  it('merges a one-day patch into the stored map instead of replacing it', () => {
    writeJournalSettings({ weekdayTemplates: { '1': 'daily-standup' } })
    writeJournalSettings({ weekdayTemplates: { '3': 'weekly-review' } })

    expect(storedMap()).toEqual({ '1': 'daily-standup', '3': 'weekly-review' })
  })

  it('keeps a cleared day as an explicit null rather than dropping the key', () => {
    writeJournalSettings({ weekdayTemplates: { '1': 'daily-standup' } })
    writeJournalSettings({ weekdayTemplates: { '1': null } })

    // The entry is what the per-day field clock refers to: drop it and the
    // clear has nothing to beat a stale remote id with.
    expect(storedMap()).toEqual({ '1': null })
    expect(getJournalSettings().weekdayTemplates).toEqual({ '1': null })
  })

  it('ignores keys outside 0..6', () => {
    writeJournalSettings({
      weekdayTemplates: { '1': 'daily-standup', '9': 'nope', monday: 'nope' }
    })

    expect(storedMap()).toEqual({ '1': 'daily-standup' })
    expect(updateField).not.toHaveBeenCalledWith('journal.weekdayTemplates.9', expect.anything())
  })

  it('degrades a corrupt weekday row to an empty map instead of throwing', () => {
    setSetting(getDatabase(), WEEKDAY_KEY, '{not json')
    expect(getJournalSettings().weekdayTemplates).toEqual({})
  })

  it('gives each day its own sync field clock', () => {
    writeJournalSettings({ weekdayTemplates: { '1': 'daily-standup' } })

    // One clock per day, not one for the whole map: two devices editing
    // different days must merge rather than overwrite each other.
    expect(updateField).toHaveBeenCalledWith('journal.weekdayTemplates.1', 'daily-standup')
    expect(updateField).not.toHaveBeenCalledWith('journal.weekdayTemplates', expect.anything())
  })

  it('syncs a cleared day as null', () => {
    writeJournalSettings({ weekdayTemplates: { '2': null } })
    expect(updateField).toHaveBeenCalledWith('journal.weekdayTemplates.2', null)
  })

  it('syncs the default template so the fallback matches across devices', () => {
    writeJournalSettings({ defaultTemplate: 'morning-pages' })
    expect(updateField).toHaveBeenCalledWith('journal.defaultTemplate', 'morning-pages')

    writeJournalSettings({ defaultTemplate: null })
    expect(updateField).toHaveBeenCalledWith('journal.defaultTemplate', null)
    expect(getSetting(getDatabase(), 'journal.defaultTemplate')).toBeNull()
  })

  it('does not sync journal visibility toggles', () => {
    writeJournalSettings({ showStatsFooter: true })
    expect(updateField).not.toHaveBeenCalledWith(
      expect.stringContaining('journal.showStatsFooter'),
      expect.anything()
    )
  })

  it('broadcasts the whole merged map, not the one-day patch', () => {
    writeJournalSettings({ weekdayTemplates: { '1': 'daily-standup' } })
    writeJournalSettings({ weekdayTemplates: { '3': 'weekly-review' } })

    // The renderer merges settings patches shallowly, so a one-day payload
    // would replace every subscriber's map with just that day.
    expect(lastJournalBroadcast()).toMatchObject({
      weekdayTemplates: { '1': 'daily-standup', '3': 'weekly-review' }
    })
  })
})
