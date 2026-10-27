import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  commands: {
    settingsGetGroup: vi.fn(),
    settingsSetGroup: vi.fn(),
    settingsGetPath: vi.fn(),
    settingsGetLocal: vi.fn(),
    settingsSetLocal: vi.fn(),
    settingsResetKeyboard: vi.fn(),
    logWrite: vi.fn()
  },
  listeners: new Map<string, (event: { payload: unknown }) => void>()
}))

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
      settingsOpenSectionEvent: event('open')
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

  it('resolves a rejected write as { success: false, error } like the Electron handlers', async () => {
    mocks.commands.settingsSetGroup.mockRejectedValue({ message: 'settings_invalid_value' })

    await expect(settingsService.setGeneralSettings({ theme: 'nope' })).resolves.toEqual({
      success: false,
      error: 'settings_invalid_value'
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

  it('reads tag searches from the flat device-local key', async () => {
    mocks.commands.settingsGetLocal.mockResolvedValue({ searches: [{ id: 'a' }] })
    await expect(settingsService.getTagSearches()).resolves.toEqual([{ id: 'a' }])
    mocks.commands.settingsGetLocal.mockResolvedValue(null)
    await expect(settingsService.getTagSearches()).resolves.toEqual([])
  })
})
