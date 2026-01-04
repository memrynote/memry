/**
 * Settings IPC handlers tests
 *
 * @module ipc/settings-handlers.test
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { mockIpcMain, resetIpcMocks, invokeHandler } from '@tests/utils/mock-ipc'
import { SettingsChannels } from '@shared/ipc-channels'

const handleCalls: unknown[][] = []
const removeHandlerCalls: string[] = []
const mockSend = vi.fn()

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
    getAllWindows: vi.fn(() => [{ webContents: { send: mockSend } }])
  }
}))

vi.mock('../database', () => ({
  getDatabase: vi.fn()
}))

vi.mock('@shared/db/queries/settings', () => ({
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

vi.mock('../inbox/suggestions', () => ({
  getEmbeddingCount: vi.fn(() => 4),
  reindexAllEmbeddings: vi.fn(() => Promise.resolve({ success: true, computed: 1, skipped: 0 }))
}))

import { registerSettingsHandlers, unregisterSettingsHandlers } from './settings-handlers'
import { getDatabase } from '../database'
import * as settingsQueries from '@shared/db/queries/settings'
import * as embeddings from '../lib/embeddings'

describe('settings-handlers', () => {
  beforeEach(() => {
    resetIpcMocks()
    vi.clearAllMocks()
    handleCalls.length = 0
    removeHandlerCalls.length = 0
    mockSend.mockClear()

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
    expect(journalSettings).toEqual({ defaultTemplate: 'template-1' })

    const setResult = await invokeHandler(SettingsChannels.invoke.SET_JOURNAL_SETTINGS, {
      defaultTemplate: 'template-2'
    })
    expect(setResult).toEqual({ success: true })
    expect(settingsQueries.setSetting).toHaveBeenCalledWith({}, 'journal.defaultTemplate', 'template-2')
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

    const suggestions = await import('../inbox/suggestions')
    ;(suggestions.reindexAllEmbeddings as Mock).mockRejectedValue(new Error('reindex failed'))

    const result = await invokeHandler(SettingsChannels.invoke.REINDEX_EMBEDDINGS)
    expect(result).toEqual({
      success: false,
      error: 'reindex failed',
      computed: 0,
      skipped: 0
    })
  })
})
