import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  listeners: new Map<string, Array<(event: { payload: unknown }) => void>>()
}))
const SETTINGS_PAGE = {
  operation: 'pull',
  items: [{ itemId: 'synced_settings', type: 'settings', itemOperation: 'update' }]
}

vi.mock('../../../generated/bindings', () => {
  const event = (name: string) => ({
    listen: vi.fn(async (handler: (event: { payload: unknown }) => void) => {
      mocks.listeners.set(name, [...(mocks.listeners.get(name) ?? []), handler])
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

/** Delivers an event to every handler a subscriber registered, as Tauri does. */
const emit = (name: 'changed' | 'synced', payload: unknown) =>
  mocks.listeners.get(name)?.forEach((handler) => handler({ payload }))

/** One pulled page that holds the settings record, through the 150 ms coalescing window. */
async function pullSettingsPage(): Promise<void> {
  vi.useFakeTimers()
  try {
    emit('synced', SETTINGS_PAGE)
    await vi.advanceTimersByTimeAsync(150)
  } finally {
    vi.useRealTimers()
  }
  await flush()
}

const stops: Array<() => void> = []
/** The shared page reader is module state: every test unsubscribes what it subscribed. */
const subscribe = (callback: Parameters<typeof onSettingsChanged>[0]): (() => void) => {
  const stop = onSettingsChanged(callback)
  stops.push(stop)
  return stop
}

describe('settingsService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listeners.clear()
  })

  afterEach(() => {
    for (const stop of stops.splice(0)) stop()
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
    subscribe((change) => seen.push(change))

    emit('changed', { key: 'ai', fields: ['enabled'] })
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
    subscribe((change) => seen.push(change))
    await flush()

    emit('changed', { key: 'general', fields: ['theme'] })
    await flush()

    expect(seen).toEqual([{ key: 'general', value: { theme: 'dark' } }])
  })

  it('addresses sidebar fields as sidebar.<field> with the field value', async () => {
    const seen: unknown[] = []
    mocks.commands.settingsGetGroup.mockResolvedValue({ notesFirst: true, showFiles: true })
    subscribe((change) => seen.push(change))
    await flush()

    emit('changed', { key: 'sidebar', fields: ['notesFirst'] })
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
    subscribe((change) => seen.push(change))

    await pullSettingsPage()

    expect(seen).toContainEqual({ key: 'general', value: { theme: 'dark' } })
    expect(seen).toContainEqual({ key: 'editor', value: { spellCheck: false } })
    expect(seen).toContainEqual({ key: 'sidebar.notesFirst', value: true })
    expect(seen).toContainEqual({ key: 'journal', value: {} })
  })

  it('reads each announced group once for a pulled page, however many listeners subscribed', async () => {
    mocks.commands.settingsGetGroup.mockResolvedValue({})
    mocks.commands.settingsGetPath.mockResolvedValue(null)
    const heard = [0, 0, 0, 0, 0]
    heard.forEach((_, index) => subscribe(() => (heard[index] += 1)))

    await pullSettingsPage()

    const reads = new Map<string, number>()
    for (const [name] of mocks.commands.settingsGetGroup.mock.calls) {
      reads.set(name, (reads.get(name) ?? 0) + 1)
    }
    expect(reads.size).toBeGreaterThan(0)
    expect([...reads.values()].every((count) => count === 1)).toBe(true)
    expect(heard.every((count) => count > 0)).toBe(true)
    expect(new Set(heard).size).toBe(1)
  })

  it("announces the groups Electron broadcast for a pulled page, and keyboard, which applies a peer's rebinds live", async () => {
    const keyboard = { overrides: { 'note.new': { key: 'n', modifiers: ['mod'] } } }
    mocks.commands.settingsGetGroup.mockImplementation(async (name: string) =>
      name === 'keyboard' ? keyboard : {}
    )
    mocks.commands.settingsGetPath.mockResolvedValue(null)
    const seen: Array<{ key: string; value: unknown }> = []
    subscribe((change) => seen.push(change))

    await pullSettingsPage()

    const read = mocks.commands.settingsGetGroup.mock.calls
      .map(([name]) => String(name))
      .toSorted((a, b) => a.localeCompare(b))
    expect(read).toEqual([
      'calendar',
      'editor',
      'general',
      'inbox',
      'journal',
      'keyboard',
      'sidebar'
    ])
    expect(seen).toContainEqual({ key: 'keyboard', value: keyboard })
    const announced = new Set(seen.map((change) => change.key))
    for (const silent of ['tasks', 'notes', 'sync', 'readwise']) {
      expect(announced.has(silent)).toBe(false)
    }
  })

  it('stops telling a listener about pulled pages and writes once it unsubscribes', async () => {
    mocks.commands.settingsGetGroup.mockResolvedValue({ theme: 'dark' })
    mocks.commands.settingsGetPath.mockResolvedValue(null)
    const stayed: unknown[] = []
    const left: unknown[] = []
    subscribe((change) => stayed.push(change))
    const stopLeaving = subscribe((change) => left.push(change))
    stopLeaving()

    await pullSettingsPage()
    expect(stayed.length).toBeGreaterThan(0)

    emit('changed', { key: 'general', fields: ['theme'] })
    await flush()
    expect(left).toEqual([])

    for (const stop of stops.splice(0)) stop()
    mocks.commands.settingsGetGroup.mockClear()
    await pullSettingsPage()

    expect(mocks.commands.settingsGetGroup).not.toHaveBeenCalled()
  })

  it('tells every other listener about a pulled page when one listener throws', async () => {
    mocks.commands.settingsGetGroup.mockResolvedValue({ theme: 'dark' })
    mocks.commands.settingsGetPath.mockResolvedValue(null)
    const heard: unknown[] = []
    subscribe(() => {
      throw new Error('listener failed')
    })
    subscribe((change) => heard.push(change))

    await pullSettingsPage()

    expect(heard).toContainEqual({ key: 'general', value: { theme: 'dark' } })
  })

  it('reads tag searches from the flat device-local key', async () => {
    mocks.commands.settingsGetLocal.mockResolvedValue({ searches: [{ id: 'a' }] })
    await expect(settingsService.getTagSearches()).resolves.toEqual([{ id: 'a' }])
    mocks.commands.settingsGetLocal.mockResolvedValue(null)
    await expect(settingsService.getTagSearches()).resolves.toEqual([])
  })
})
