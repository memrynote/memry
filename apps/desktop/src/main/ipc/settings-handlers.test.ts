/**
 * Settings IPC handlers tests
 *
 * @module ipc/settings-handlers.test
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { mockIpcMain, resetIpcMocks, invokeHandler } from '@tests/utils/mock-ipc'
import { SettingsChannels } from '@memry/contracts/ipc-channels'

const handleCalls: unknown[][] = []
const removeHandlerCalls: string[] = []
const mockSend = vi.fn()
const mockGetVoiceModelStatus = vi.hoisted(() => vi.fn())
const mockDownloadVoiceModel = vi.hoisted(() => vi.fn())
const mockGetVoiceRecordingReadiness = vi.hoisted(() => vi.fn())
const mockHasVoiceTranscriptionOpenAIApiKey = vi.hoisted(() => vi.fn())
const mockSetVoiceTranscriptionOpenAIApiKey = vi.hoisted(() => vi.fn())
const syncListeners = new Map<
  string,
  (event: { returnValue: unknown }, ...args: unknown[]) => void
>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: unknown) => {
      handleCalls.push([channel, handler])
      mockIpcMain.handle(channel, handler as Parameters<typeof mockIpcMain.handle>[1])
    }),
    on: vi.fn(
      (channel: string, handler: (event: { returnValue: unknown }, ...args: unknown[]) => void) => {
        syncListeners.set(channel, handler)
      }
    ),
    removeHandler: vi.fn((channel: string) => {
      removeHandlerCalls.push(channel)
      mockIpcMain.removeHandler(channel)
    }),
    removeAllListeners: vi.fn((channel: string) => {
      syncListeners.delete(channel)
    })
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => [{ webContents: { send: mockSend } }])
  }
}))

vi.mock('../database', () => ({
  getDatabase: vi.fn(),
  requireDatabase: vi.fn()
}))

vi.mock('@main/database/queries/settings', () => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  deleteSetting: vi.fn()
}))

vi.mock('../lib/embeddings', () => ({
  initEmbeddingModel: vi.fn(),
  getModelInfo: vi.fn(),
  isModelLoaded: vi.fn(),
  isModelLoading: vi.fn()
}))

vi.mock('../inbox/voice-model', () => ({
  getVoiceModelStatus: mockGetVoiceModelStatus,
  downloadVoiceModel: mockDownloadVoiceModel
}))

vi.mock('../inbox/voice-transcription-settings', () => ({
  getVoiceRecordingReadiness: mockGetVoiceRecordingReadiness
}))

vi.mock('../inbox/voice-transcription-keychain', () => ({
  hasVoiceTranscriptionOpenAIApiKey: mockHasVoiceTranscriptionOpenAIApiKey,
  setVoiceTranscriptionOpenAIApiKey: mockSetVoiceTranscriptionOpenAIApiKey
}))

const mockUpdateField = vi.fn()
vi.mock('../sync/settings-sync', () => ({
  getSettingsSyncManager: vi.fn(() => ({
    updateField: mockUpdateField
  }))
}))

vi.mock('../projections', () => ({
  rebuildProjections: vi.fn(() =>
    Promise.resolve({
      embedding: { success: true, computed: 1, skipped: 0 }
    })
  )
}))

vi.mock('../inbox/suggestions', () => ({
  getEmbeddingCount: vi.fn(() => 4)
}))

const mockWritePreferences = vi.fn()
const mockGetCurrentVaultPath = vi.fn(() => '/test/vault')
vi.mock('../vault/vault-preferences', () => ({
  writePreferences: (...args: unknown[]) => mockWritePreferences(...args),
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
  getCurrentVaultPath: () => mockGetCurrentVaultPath()
}))

import { registerSettingsHandlers, unregisterSettingsHandlers } from './settings-handlers'
import { getDatabase } from '../database'
import * as settingsQueries from '@main/database/queries/settings'
import * as embeddings from '../lib/embeddings'
import * as projections from '../projections'
import { getSettingsSyncManager } from '../sync/settings-sync'

function invokeSyncHandler<T>(channel: string, ...args: unknown[]): T {
  const listener = syncListeners.get(channel)
  if (!listener) {
    throw new Error(`No sync listener registered for channel: ${channel}`)
  }

  const event = { returnValue: undefined as unknown }
  listener(event, ...args)
  return event.returnValue as T
}

describe('settings-handlers', () => {
  beforeEach(() => {
    resetIpcMocks()
    vi.clearAllMocks()
    handleCalls.length = 0
    removeHandlerCalls.length = 0
    syncListeners.clear()
    mockSend.mockClear()
    mockUpdateField.mockClear()
    mockWritePreferences.mockClear()
    mockGetCurrentVaultPath.mockReturnValue('/test/vault')
    mockGetVoiceModelStatus.mockReset().mockReturnValue({
      name: 'Whisper Small',
      downloaded: false,
      loaded: false,
      loading: false,
      error: null
    })
    mockDownloadVoiceModel.mockReset().mockResolvedValue(true)
    mockGetVoiceRecordingReadiness.mockReset().mockResolvedValue({
      ready: false,
      provider: 'local',
      reason: 'missing-model',
      message: 'Download Whisper Small in Settings to record voice memos.'
    })
    mockHasVoiceTranscriptionOpenAIApiKey.mockReset().mockResolvedValue(false)
    mockSetVoiceTranscriptionOpenAIApiKey.mockReset().mockResolvedValue(undefined)
    ;(getDatabase as Mock).mockReturnValue({})
  })

  afterEach(() => {
    unregisterSettingsHandlers()
  })

  it('gets and sets settings with change events', async () => {
    registerSettingsHandlers()
    ;(settingsQueries.getSetting as Mock).mockReturnValue('value-1')

    const getResult = await invokeHandler(SettingsChannels.invoke.GET, 'settings.key')
    expect(getResult).toBe('value-1')

    const setResult = await invokeHandler(SettingsChannels.invoke.SET, {
      key: 'settings.key',
      value: 'value-2'
    })
    expect(setResult).toEqual({ success: true })
    expect(settingsQueries.setSetting).toHaveBeenCalledWith({}, 'settings.key', 'value-2')
    expect(mockSend).toHaveBeenCalledWith(SettingsChannels.events.CHANGED, {
      key: 'settings.key',
      value: 'value-2'
    })
  })

  it('returns the startup theme and accent color synchronously', () => {
    registerSettingsHandlers()
    ;(settingsQueries.getSetting as Mock).mockReturnValue(
      JSON.stringify({ theme: 'light', accentColor: '#6366f1' })
    )

    const result = invokeSyncHandler<{ theme: string; accentColor?: string }>(
      SettingsChannels.sync.GET_STARTUP_THEME
    )

    expect(result).toEqual({ theme: 'light', accentColor: '#6366f1' })
  })

  it('returns defaults when no database is open', async () => {
    registerSettingsHandlers()
    ;(getDatabase as Mock).mockImplementation(() => {
      throw new Error('no db')
    })

    const getResult = await invokeHandler(SettingsChannels.invoke.GET, 'settings.key')
    expect(getResult).toBeNull()

    const aiResult = await invokeHandler(SettingsChannels.invoke.GET_AI_SETTINGS)
    expect(aiResult).toEqual({ enabled: true })
  })

  it('gets and sets journal settings', async () => {
    registerSettingsHandlers()
    ;(settingsQueries.getSetting as Mock).mockReturnValue('template-1')
    const journalSettings = await invokeHandler(SettingsChannels.invoke.GET_JOURNAL_SETTINGS)
    expect(journalSettings).toEqual({
      defaultTemplate: 'template-1',
      showSchedule: true,
      showTasks: true,
      showAIConnections: true,
      showStatsFooter: false
    })

    const setResult = await invokeHandler(SettingsChannels.invoke.SET_JOURNAL_SETTINGS, {
      defaultTemplate: 'template-2'
    })
    expect(setResult).toEqual({ success: true })
    expect(settingsQueries.setSetting).toHaveBeenCalledWith(
      {},
      'journal.defaultTemplate',
      'template-2'
    )
    expect(mockSend).toHaveBeenCalledWith(SettingsChannels.events.CHANGED, {
      key: 'journal',
      value: { defaultTemplate: 'template-2' }
    })

    const clearResult = await invokeHandler(SettingsChannels.invoke.SET_JOURNAL_SETTINGS, {
      defaultTemplate: null
    })
    expect(clearResult).toEqual({ success: true })
    expect(settingsQueries.deleteSetting).toHaveBeenCalledWith({}, 'journal.defaultTemplate')
  })

  it('gets and sets AI settings', async () => {
    registerSettingsHandlers()
    ;(settingsQueries.getSetting as Mock).mockReturnValue('false')
    const aiSettings = await invokeHandler(SettingsChannels.invoke.GET_AI_SETTINGS)
    expect(aiSettings).toEqual({ enabled: false })

    const setAi = await invokeHandler(SettingsChannels.invoke.SET_AI_SETTINGS, { enabled: false })
    expect(setAi).toEqual({ success: true })
    expect(settingsQueries.setSetting).toHaveBeenCalledWith({}, 'ai.enabled', 'false')
    expect(mockSend).toHaveBeenCalledWith(SettingsChannels.events.CHANGED, {
      key: 'ai',
      value: { enabled: false }
    })
  })

  it('gets and sets voice transcription settings', async () => {
    registerSettingsHandlers()
    ;(settingsQueries.getSetting as Mock).mockReturnValue(JSON.stringify({ provider: 'openai' }))

    const voiceSettings = await invokeHandler(
      SettingsChannels.invoke.GET_VOICE_TRANSCRIPTION_SETTINGS
    )
    expect(voiceSettings).toEqual({ provider: 'openai' })

    const setVoiceSettings = await invokeHandler(
      SettingsChannels.invoke.SET_VOICE_TRANSCRIPTION_SETTINGS,
      { provider: 'openai' }
    )
    expect(setVoiceSettings).toEqual({ success: true })
    expect(settingsQueries.setSetting).toHaveBeenCalledWith(
      {},
      'voiceTranscription',
      JSON.stringify({ provider: 'openai' })
    )
    expect(mockSend).toHaveBeenCalledWith(SettingsChannels.events.CHANGED, {
      key: 'voiceTranscription',
      value: { provider: 'openai' }
    })
  })

  it('exposes voice model, readiness, and BYOK handlers', async () => {
    registerSettingsHandlers()
    mockGetVoiceRecordingReadiness.mockResolvedValue({
      ready: false,
      provider: 'local',
      reason: 'missing-model',
      message: 'Download Whisper Small in Settings to record voice memos.'
    })
    mockHasVoiceTranscriptionOpenAIApiKey.mockResolvedValue(true)

    const modelStatus = await invokeHandler(SettingsChannels.invoke.GET_VOICE_MODEL_STATUS)
    expect(modelStatus).toEqual({
      name: 'Whisper Small',
      downloaded: false,
      loaded: false,
      loading: false,
      error: null
    })

    const readiness = await invokeHandler(SettingsChannels.invoke.GET_VOICE_RECORDING_READINESS)
    expect(readiness).toEqual({
      ready: false,
      provider: 'local',
      reason: 'missing-model',
      message: 'Download Whisper Small in Settings to record voice memos.'
    })

    const apiKeyStatus = await invokeHandler(
      SettingsChannels.invoke.GET_VOICE_TRANSCRIPTION_OPENAI_KEY_STATUS
    )
    expect(apiKeyStatus).toEqual({ hasApiKey: true })

    const setApiKey = await invokeHandler(
      SettingsChannels.invoke.SET_VOICE_TRANSCRIPTION_OPENAI_KEY,
      { apiKey: 'sk-test' }
    )
    expect(setApiKey).toEqual({ success: true })
    expect(mockSetVoiceTranscriptionOpenAIApiKey).toHaveBeenCalledWith('sk-test')

    const download = await invokeHandler(SettingsChannels.invoke.DOWNLOAD_VOICE_MODEL)
    expect(download).toEqual({ success: true })
    expect(mockDownloadVoiceModel).toHaveBeenCalledOnce()
  })

  it('handles AI model status and load flows', async () => {
    registerSettingsHandlers()
    ;(embeddings.getModelInfo as Mock).mockReturnValue({
      name: 'all-MiniLM-L6-v2',
      dimension: 384,
      loaded: false,
      loading: false,
      error: null
    })
    ;(embeddings.isModelLoaded as Mock).mockReturnValue(false)
    ;(embeddings.isModelLoading as Mock).mockReturnValue(false)
    ;(embeddings.initEmbeddingModel as Mock).mockResolvedValue(true)

    const status = await invokeHandler(SettingsChannels.invoke.GET_AI_MODEL_STATUS)
    expect(status).toEqual(expect.objectContaining({ embeddingCount: 4 }))

    const loadResult = await invokeHandler(SettingsChannels.invoke.LOAD_AI_MODEL)
    expect(loadResult).toEqual({ success: true })
  })

  it('returns proper responses for model loading edge cases', async () => {
    registerSettingsHandlers()
    ;(embeddings.isModelLoaded as Mock).mockReturnValue(true)
    const loadedResult = await invokeHandler(SettingsChannels.invoke.LOAD_AI_MODEL)
    expect(loadedResult).toEqual({ success: true, message: 'Model already loaded' })
    ;(embeddings.isModelLoaded as Mock).mockReturnValue(false)
    ;(embeddings.isModelLoading as Mock).mockReturnValue(true)
    const loadingResult = await invokeHandler(SettingsChannels.invoke.LOAD_AI_MODEL)
    expect(loadingResult).toEqual({ success: false, error: 'Model is already loading' })
    ;(embeddings.isModelLoading as Mock).mockReturnValue(false)
    ;(embeddings.initEmbeddingModel as Mock).mockResolvedValue(false)
    ;(embeddings.getModelInfo as Mock).mockReturnValue({
      name: 'all-MiniLM-L6-v2',
      dimension: 384,
      loaded: false,
      loading: false,
      error: 'init failed'
    })
    const failedResult = await invokeHandler(SettingsChannels.invoke.LOAD_AI_MODEL)
    expect(failedResult).toEqual({ success: false, error: 'init failed' })
  })

  it('reindexes embeddings and updates tab settings', async () => {
    registerSettingsHandlers()

    const reindexResult = await invokeHandler(SettingsChannels.invoke.REINDEX_EMBEDDINGS)
    expect(reindexResult).toEqual({ success: true, computed: 1, skipped: 0 })
    ;(settingsQueries.getSetting as Mock).mockReturnValue(null)
    const tabSettings = await invokeHandler(SettingsChannels.invoke.GET_TAB_SETTINGS)
    expect(tabSettings).toEqual(
      expect.objectContaining({ previewMode: false, restoreSessionOnStart: true })
    )

    const updateTabs = await invokeHandler(SettingsChannels.invoke.SET_TAB_SETTINGS, {
      previewMode: true,
      tabCloseButton: 'always'
    })
    expect(updateTabs).toEqual({ success: true })
    expect(mockSend).toHaveBeenCalledWith(SettingsChannels.events.CHANGED, {
      key: 'tabs',
      value: { previewMode: true, tabCloseButton: 'always' }
    })
  })

  it('returns errors when setters are called without a vault', async () => {
    registerSettingsHandlers()
    ;(getDatabase as Mock).mockImplementation(() => {
      throw new Error('no db')
    })

    const setResult = await invokeHandler(SettingsChannels.invoke.SET, {
      key: 'settings.key',
      value: 'value'
    })
    expect(setResult).toEqual({ success: false, error: 'No vault open' })

    const tabResult = await invokeHandler(SettingsChannels.invoke.SET_TAB_SETTINGS, {
      previewMode: true
    })
    expect(tabResult).toEqual({ success: false, error: 'No vault open' })
  })

  it('returns error when reindex embeddings fails', async () => {
    registerSettingsHandlers()
    ;(projections.rebuildProjections as Mock).mockRejectedValue(new Error('reindex failed'))

    const result = await invokeHandler(SettingsChannels.invoke.REINDEX_EMBEDDINGS)
    expect(result).toEqual({
      success: false,
      error: 'reindex failed'
    })
  })

  it('gets and sets note editor settings', async () => {
    registerSettingsHandlers()
    ;(settingsQueries.getSetting as Mock).mockReturnValue(null)
    const defaultSettings = await invokeHandler(SettingsChannels.invoke.GET_NOTE_EDITOR_SETTINGS)
    expect(defaultSettings).toEqual({ toolbarMode: 'floating' })
    ;(settingsQueries.getSetting as Mock).mockReturnValue('sticky')
    const stickySettings = await invokeHandler(SettingsChannels.invoke.GET_NOTE_EDITOR_SETTINGS)
    expect(stickySettings).toEqual({ toolbarMode: 'sticky' })

    const setResult = await invokeHandler(SettingsChannels.invoke.SET_NOTE_EDITOR_SETTINGS, {
      toolbarMode: 'sticky'
    })
    expect(setResult).toEqual({ success: true })
    expect(settingsQueries.setSetting).toHaveBeenCalledWith({}, 'noteEditor.toolbarMode', 'sticky')
    expect(mockSend).toHaveBeenCalledWith(SettingsChannels.events.CHANGED, {
      key: 'noteEditor',
      value: { toolbarMode: 'sticky' }
    })
  })

  it('returns default note editor settings when no vault is open', async () => {
    registerSettingsHandlers()
    ;(getDatabase as Mock).mockImplementation(() => {
      throw new Error('no db')
    })

    const result = await invokeHandler(SettingsChannels.invoke.GET_NOTE_EDITOR_SETTINGS)
    expect(result).toEqual({ toolbarMode: 'floating' })
  })

  it('returns error when setting note editor settings without a vault', async () => {
    registerSettingsHandlers()
    ;(getDatabase as Mock).mockImplementation(() => {
      throw new Error('no db')
    })

    const result = await invokeHandler(SettingsChannels.invoke.SET_NOTE_EDITOR_SETTINGS, {
      toolbarMode: 'sticky'
    })
    expect(result).toEqual({ success: false, error: 'No vault open' })
  })

  describe('cross-device settings sync', () => {
    it('#given sync manager exists #when accentColor is set #then syncs via updateField', async () => {
      registerSettingsHandlers()

      // #when
      await invokeHandler(SettingsChannels.invoke.SET_GENERAL_SETTINGS, {
        accentColor: '#ef4444'
      })

      // #then
      expect(mockUpdateField).toHaveBeenCalledWith('general.accentColor', '#ef4444', 'local')
    })

    it('#given sync manager exists #when theme is set #then syncs via updateField', async () => {
      registerSettingsHandlers()

      // #when
      await invokeHandler(SettingsChannels.invoke.SET_GENERAL_SETTINGS, { theme: 'dark' })

      // #then
      expect(mockUpdateField).toHaveBeenCalledWith('general.theme', 'dark', 'local')
    })

    it('#given sync manager exists #when fontSize is set #then syncs via updateField', async () => {
      registerSettingsHandlers()

      // #when
      await invokeHandler(SettingsChannels.invoke.SET_GENERAL_SETTINGS, { fontSize: 'large' })

      // #then
      expect(mockUpdateField).toHaveBeenCalledWith('general.fontSize', 'large', 'local')
    })

    it('#given sync manager exists #when fontFamily is set #then syncs via updateField', async () => {
      registerSettingsHandlers()

      // #when
      await invokeHandler(SettingsChannels.invoke.SET_GENERAL_SETTINGS, {
        fontFamily: 'monospace'
      })

      // #then
      expect(mockUpdateField).toHaveBeenCalledWith('general.fontFamily', 'monospace', 'local')
    })

    it('#given sync manager exists #when startOnBoot is set #then does NOT sync (device-specific)', async () => {
      registerSettingsHandlers()

      // #when
      await invokeHandler(SettingsChannels.invoke.SET_GENERAL_SETTINGS, { startOnBoot: true })

      // #then
      expect(mockUpdateField).not.toHaveBeenCalled()
    })

    it('#given sync manager exists #when multiple syncable fields updated #then syncs each', async () => {
      registerSettingsHandlers()

      // #when
      await invokeHandler(SettingsChannels.invoke.SET_GENERAL_SETTINGS, {
        accentColor: '#10b981',
        theme: 'white'
      })

      // #then
      expect(mockUpdateField).toHaveBeenCalledWith('general.accentColor', '#10b981', 'local')
      expect(mockUpdateField).toHaveBeenCalledWith('general.theme', 'white', 'local')
      expect(mockUpdateField).toHaveBeenCalledTimes(2)
    })

    it('#given no sync manager #when accentColor is set #then does not throw', async () => {
      registerSettingsHandlers()
      ;(getSettingsSyncManager as Mock).mockReturnValue(null)

      // #when / #then — should not throw
      const result = await invokeHandler(SettingsChannels.invoke.SET_GENERAL_SETTINGS, {
        accentColor: '#ef4444'
      })
      expect(result).toEqual({ success: true })
    })
  })

  describe('config.json write-through', () => {
    it('#given vault open #when portable general setting changed #then writes to config.json', async () => {
      registerSettingsHandlers()

      await invokeHandler(SettingsChannels.invoke.SET_GENERAL_SETTINGS, { theme: 'dark' })

      expect(mockWritePreferences).toHaveBeenCalledWith('/test/vault', { theme: 'dark' })
    })

    it('#given vault open #when multiple portable fields changed #then writes all to config.json', async () => {
      registerSettingsHandlers()

      await invokeHandler(SettingsChannels.invoke.SET_GENERAL_SETTINGS, {
        theme: 'dark',
        accentColor: '#ef4444',
        language: 'tr'
      })

      expect(mockWritePreferences).toHaveBeenCalledWith('/test/vault', {
        theme: 'dark',
        accentColor: '#ef4444',
        language: 'tr'
      })
    })

    it('#given vault open #when machine-local field changed #then does NOT write to config.json', async () => {
      registerSettingsHandlers()

      await invokeHandler(SettingsChannels.invoke.SET_GENERAL_SETTINGS, { startOnBoot: true })

      expect(mockWritePreferences).not.toHaveBeenCalled()
    })

    it('#given vault open #when mix of portable+local fields #then writes only portable to config.json', async () => {
      registerSettingsHandlers()

      await invokeHandler(SettingsChannels.invoke.SET_GENERAL_SETTINGS, {
        theme: 'dark',
        startOnBoot: true,
        onboardingCompleted: true
      })

      expect(mockWritePreferences).toHaveBeenCalledWith('/test/vault', { theme: 'dark' })
    })

    it('#given vault open #when editor settings changed #then writes to config.json', async () => {
      registerSettingsHandlers()

      await invokeHandler(SettingsChannels.invoke.SET_EDITOR_SETTINGS, { width: 'wide' })

      expect(mockWritePreferences).toHaveBeenCalledWith('/test/vault', {
        editor: { width: 'wide' }
      })
    })

    it('#given no vault path #when setting changed #then skips config.json write gracefully', async () => {
      registerSettingsHandlers()
      mockGetCurrentVaultPath.mockReturnValue(null)

      await invokeHandler(SettingsChannels.invoke.SET_GENERAL_SETTINGS, { theme: 'dark' })

      expect(mockWritePreferences).not.toHaveBeenCalled()
      expect(settingsQueries.setSetting).toHaveBeenCalled()
    })
  })

  describe('startup accent color', () => {
    it('#given general settings with accentColor #when startup theme requested #then returns accent color', () => {
      registerSettingsHandlers()
      ;(settingsQueries.getSetting as Mock).mockReturnValue(
        JSON.stringify({ theme: 'dark', accentColor: '#ef4444' })
      )

      const result = invokeSyncHandler<{ theme: string; accentColor?: string }>(
        SettingsChannels.sync.GET_STARTUP_THEME
      )

      expect(result).toEqual({ theme: 'dark', accentColor: '#ef4444' })
    })

    it('#given no accentColor saved #when startup theme requested #then returns theme with default accent', () => {
      registerSettingsHandlers()
      ;(settingsQueries.getSetting as Mock).mockReturnValue(JSON.stringify({ theme: 'white' }))

      const result = invokeSyncHandler<{ theme: string; accentColor?: string }>(
        SettingsChannels.sync.GET_STARTUP_THEME
      )

      expect(result).toEqual({ theme: 'white', accentColor: '#6366f1' })
    })

    it('#given no settings in db #when startup theme requested #then returns defaults', () => {
      registerSettingsHandlers()
      ;(settingsQueries.getSetting as Mock).mockReturnValue(null)

      const result = invokeSyncHandler<{ theme: string; accentColor?: string }>(
        SettingsChannels.sync.GET_STARTUP_THEME
      )

      expect(result).toEqual({ theme: 'system', accentColor: '#6366f1' })
    })
  })
})
