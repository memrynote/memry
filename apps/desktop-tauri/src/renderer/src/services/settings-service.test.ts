import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  commands: {
    settingsGetGroup: vi.fn(),
    settingsSetGroup: vi.fn(),
    settingsGetPath: vi.fn(),
    settingsGetLocal: vi.fn(),
    settingsSetLocal: vi.fn(),
    settingsResetKeyboard: vi.fn(),
    settingsGetAi: vi.fn(),
    settingsSetAi: vi.fn(),
    settingsDownloadVoiceModel: vi.fn(),
    settingsSetVoiceTranscriptionOpenaiKey: vi.fn(),
    logWrite: vi.fn()
  },
  listeners: new Map<string, (event: { payload: unknown }) => void>()
}))
const SETTINGS_PAGE = {
  operation: 'pull',
  items: [{ itemId: 'synced_settings', type: 'settings', itemOperation: 'update' }]
}

vi.mock('../../../generated/bindings', () => {
  const event = (name: string) => ({
    listen: vi.fn(async (handler: (event: { payload: unknown }) => void) => {
      mocks.listeners.set(name, handler)
      return () => undefined
    })
  })
  return {
    commands: mocks.commands,
    events: {
      settingsChangedEvent: event('changed'),
      settingsOpenSectionEvent: event('open'),
      syncItemSyncedEvent: event('synced')
    }
  }
})

import { onSettingsChanged, settingsService } from './settings-service'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('settingsService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listeners.clear()
  })

  it('fills the per-surface defaults under the sidebar sort modes a user changed', async () => {
    mocks.commands.settingsGetGroup.mockResolvedValue({ sortModes: { notes: 'title-asc' } })

    const modes = await settingsService.getSidebarSortModes()

    expect(modes.notes).toBe('title-asc')
    expect(Object.keys(modes).length).toBeGreaterThan(1)
  })

  it('reads and writes the AI switches through their own commands', async () => {
    const ai = {
      enabled: true,
      imageEmbeddings: true,
      summarizeLongNotes: true,
      summarizeAgent: 'codex_cli'
    }
    mocks.commands.settingsGetAi.mockResolvedValue(ai)
    await expect(settingsService.getAISettings()).resolves.toEqual(ai)

    mocks.commands.settingsSetAi.mockResolvedValueOnce(null)
    await expect(settingsService.setAISettings({ summarizeLongNotes: false })).resolves.toEqual({
      success: true
    })
    expect(mocks.commands.settingsSetAi).toHaveBeenCalledWith({ summarizeLongNotes: false })

    mocks.commands.settingsSetAi.mockRejectedValueOnce({ message: 'No vault is open' })
    await expect(settingsService.setAISettings({ enabled: false })).resolves.toEqual({
      success: false,
      error: 'No vault is open'
    })
  })

  it('hands an AI listener the written switches read from the AI command', async () => {
    mocks.commands.settingsGetAi.mockResolvedValue({
      enabled: false,
      imageEmbeddings: true,
      summarizeLongNotes: false,
      summarizeAgent: 'auto'
    })
    const seen: unknown[] = []
    onSettingsChanged((change) => seen.push(change))

    mocks.listeners.get('changed')?.({ payload: { key: 'ai', fields: ['enabled'] } })
    await flush()

    expect(seen).toEqual([{ key: 'ai', value: { enabled: false } }])
    expect(mocks.commands.settingsGetGroup).not.toHaveBeenCalled()
  })

  it('resolves a rejected write as { success: false, error } like the Electron handlers', async () => {
    mocks.commands.settingsSetGroup.mockRejectedValue({ message: 'settings_invalid_value' })

    await expect(settingsService.setGeneralSettings({ theme: 'nope' })).resolves.toEqual({
      success: false,
      error: 'settings_invalid_value'
    })
  })

  it('answers the voice model download and key writes in the Electron result shape', async () => {
    mocks.commands.settingsDownloadVoiceModel.mockResolvedValueOnce(null)
    await expect(settingsService.downloadVoiceModel()).resolves.toEqual({ success: true })
    mocks.commands.settingsDownloadVoiceModel.mockRejectedValueOnce({
      kind: 'transport',
      code: 'voice_model_download_failed',
      message: 'ggml-small.bin does not match its pinned SHA-256'
    })
    await expect(settingsService.downloadVoiceModel()).resolves.toEqual({
      success: false,
      error: 'ggml-small.bin does not match its pinned SHA-256'
    })

    mocks.commands.settingsSetVoiceTranscriptionOpenaiKey.mockRejectedValueOnce({
      message: 'Failed to store voice transcription API key: locked'
    })
    await expect(settingsService.setVoiceTranscriptionOpenAIKey('sk-1')).resolves.toEqual({
      success: false,
      error: 'Failed to store voice transcription API key: locked'
    })
    expect(mocks.commands.settingsSetVoiceTranscriptionOpenaiKey).toHaveBeenCalledWith('sk-1')
  })

  it('reads callout types as a list and writes only the changed entries, null for a removal', async () => {
    const note = { name: 'note-x', label: 'Note X', icon: 'info', color: '#336699' }
    mocks.commands.settingsGetPath.mockResolvedValue({
      'note-x': note,
      gone: { ...note, name: 'gone' }
    })

    const list = await settingsService.getCalloutTypes()
    expect(Array.isArray(list)).toBe(true)

    mocks.commands.settingsSetGroup.mockResolvedValue(null)
    mocks.commands.settingsGetPath.mockResolvedValue({
      'note-x': note,
      gone: { ...note, name: 'gone' }
    })
    await settingsService.setCalloutTypes(
      list.filter((d) => (d as { name: string }).name !== 'gone')
    )

    expect(mocks.commands.settingsSetGroup).toHaveBeenCalledWith('editor', {
      calloutTypes: { gone: null }
    })
  })

  it('hands a listener the written fields as { key, value }', async () => {
    const seen: unknown[] = []
    mocks.commands.settingsGetGroup.mockResolvedValue({ theme: 'dark', fontSizePx: 16 })
    onSettingsChanged((change) => seen.push(change))
    await flush()

    mocks.listeners.get('changed')?.({ payload: { key: 'general', fields: ['theme'] } })
    await flush()

    expect(seen).toEqual([{ key: 'general', value: { theme: 'dark' } }])
  })

  it('addresses sidebar fields as sidebar.<field> with the field value', async () => {
    const seen: unknown[] = []
    mocks.commands.settingsGetGroup.mockResolvedValue({ notesFirst: true, showFiles: true })
    onSettingsChanged((change) => seen.push(change))
    await flush()

    mocks.listeners.get('changed')?.({ payload: { key: 'sidebar', fields: ['notesFirst'] } })
    await flush()

    expect(seen).toEqual([{ key: 'sidebar.notesFirst', value: true }])
  })

  it('hands each synced group to a listener when a pulled page holds the settings', async () => {
    const groups: Record<string, Record<string, unknown>> = {
      general: { theme: 'dark' },
      editor: { spellCheck: false },
      sidebar: { notesFirst: true }
    }
    mocks.commands.settingsGetGroup.mockImplementation(async (name: string) => groups[name] ?? {})
    mocks.commands.settingsGetPath.mockResolvedValue(null)
    const seen: Array<{ key: string; value: unknown }> = []
    vi.useFakeTimers()
    try {
      onSettingsChanged((change) => seen.push(change))
      await vi.advanceTimersByTimeAsync(0)

      mocks.listeners.get('synced')?.({ payload: SETTINGS_PAGE })
      await vi.advanceTimersByTimeAsync(150)
    } finally {
      vi.useRealTimers()
    }

    expect(seen).toContainEqual({ key: 'general', value: { theme: 'dark' } })
    expect(seen).toContainEqual({ key: 'editor', value: { spellCheck: false } })
    expect(seen).toContainEqual({ key: 'sidebar.notesFirst', value: true })
    expect(seen).toContainEqual({ key: 'journal', value: {} })
  })

  it('reads tag searches from the flat device-local key', async () => {
    mocks.commands.settingsGetLocal.mockResolvedValue({ searches: [{ id: 'a' }] })
    await expect(settingsService.getTagSearches()).resolves.toEqual([{ id: 'a' }])
    mocks.commands.settingsGetLocal.mockResolvedValue(null)
    await expect(settingsService.getTagSearches()).resolves.toEqual([])
  })
})
