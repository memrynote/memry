/**
 * Inbox settings IPC handler tests.
 *
 * @module ipc/settings-handlers.inbox.test
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
// subsystems). Mirror the mocks proven out in settings-handlers.test.ts so this
// file can import the module directly and exercise the real settings table via
// an in-memory DB, per Task 3's pattern.
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

import { getDatabase } from '../database'
import { getSetting, setSetting } from '../database/queries/settings'
import { INBOX_REVIEW_LAST_NOTIFIED_KEY } from '../inbox/review-reminder-constants'
import { getInboxReviewSettings, writeInboxReviewSettings } from './settings-handlers'

describe('inbox settings handler', () => {
  let testDb: TestDatabaseResult

  beforeEach(() => {
    updateField.mockClear()
    testDb = createTestDatabase()
    vi.mocked(getDatabase).mockReturnValue(asClientDb(testDb.db))
  })

  afterEach(() => {
    cleanupTestDatabase(testDb)
  })

  it('round-trips and defaults', () => {
    expect(getInboxReviewSettings()).toEqual({
      reviewReminderEnabled: false,
      reviewReminderTime: '18:00',
      imageFilingMode: 'embed',
      imageFilingModeRemembered: false
    })
  })

  it('persists updates and pushes changed fields to sync', () => {
    writeInboxReviewSettings({ reviewReminderEnabled: true, reviewReminderTime: '06:30' })
    expect(getInboxReviewSettings()).toEqual({
      reviewReminderEnabled: true,
      reviewReminderTime: '06:30',
      imageFilingMode: 'embed',
      imageFilingModeRemembered: false
    })
    expect(getSetting(getDatabase(), 'inbox')).toContain('06:30')
    expect(updateField).toHaveBeenCalledWith('inbox.reviewReminderEnabled', true)
    expect(updateField).toHaveBeenCalledWith('inbox.reviewReminderTime', '06:30')
  })

  it('only pushes the fields present in the update', () => {
    writeInboxReviewSettings({ reviewReminderTime: '09:00' })
    expect(updateField).toHaveBeenCalledWith('inbox.reviewReminderTime', '09:00')
    expect(updateField).not.toHaveBeenCalledWith('inbox.reviewReminderEnabled', expect.anything())
  })

  it('clears the last-notified guard when the reminder time changes', () => {
    setSetting(getDatabase(), INBOX_REVIEW_LAST_NOTIFIED_KEY, '2026-07-17')
    writeInboxReviewSettings({ reviewReminderTime: '11:00' })
    expect(getSetting(getDatabase(), INBOX_REVIEW_LAST_NOTIFIED_KEY)).toBeNull()
  })

  it('clears the last-notified guard when the reminder is toggled', () => {
    setSetting(getDatabase(), INBOX_REVIEW_LAST_NOTIFIED_KEY, '2026-07-17')
    writeInboxReviewSettings({ reviewReminderEnabled: true })
    expect(getSetting(getDatabase(), INBOX_REVIEW_LAST_NOTIFIED_KEY)).toBeNull()
  })
})
