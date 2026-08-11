import { beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({
  windows: [] as Array<{
    isDestroyed: () => boolean
    webContents: { send: ReturnType<typeof vi.fn> }
  }>,
  getDatabase: vi.fn(() => ({})),
  getSetting: vi.fn(() => null),
  setSetting: vi.fn(),
  getCurrentVaultPath: vi.fn(() => '/vault'),
  setStoredLocale: vi.fn(),
  writePreferences: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => hoisted.windows) }
}))

vi.mock('@memry/i18n/main', () => ({
  createMainI18n: vi.fn(),
  loadResources: vi.fn()
}))

vi.mock('../database', () => ({
  getDatabase: hoisted.getDatabase
}))

vi.mock('../settings/settings-store', () => ({
  getSetting: hoisted.getSetting,
  setSetting: hoisted.setSetting
}))

vi.mock('../store', () => ({
  getCurrentVaultPath: hoisted.getCurrentVaultPath,
  setStoredLocale: hoisted.setStoredLocale
}))

vi.mock('../vault/vault-preferences', () => ({
  writePreferences: hoisted.writePreferences
}))

import { ipcMain } from 'electron'
import { registerLocaleHandlers } from './locale-handler'

describe('locale handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hoisted.windows = []
    hoisted.getDatabase.mockReturnValue({})
    hoisted.getSetting.mockReturnValue(null)
    hoisted.getCurrentVaultPath.mockReturnValue('/vault')
  })

  it('registers get, set, list channels', () => {
    const mockI18n = { changeLanguage: vi.fn(), language: 'en' } as any
    registerLocaleHandlers(mockI18n, () => {})

    expect(ipcMain.handle).toHaveBeenCalledWith('locale:get', expect.any(Function))
    expect(ipcMain.handle).toHaveBeenCalledWith('locale:set', expect.any(Function))
    expect(ipcMain.handle).toHaveBeenCalledWith('locale:list', expect.any(Function))
  })

  it('rejects an invalid locale string', async () => {
    const mockI18n = { changeLanguage: vi.fn(), language: 'en' } as any
    registerLocaleHandlers(mockI18n, () => {})
    const setHandler = (ipcMain.handle as any).mock.calls.find(
      ([channel]: [string]) => channel === 'locale:set'
    )[1]

    await expect(setHandler({}, 'invalid' as any)).rejects.toThrow()
  })

  it('persists, updates i18n, rebuilds menu, and broadcasts locale changes', async () => {
    const send = vi.fn()
    const mockI18n = { changeLanguage: vi.fn(), language: 'en' } as any
    const rebuildMenu = vi.fn()
    hoisted.windows = [{ isDestroyed: () => false, webContents: { send } }]
    hoisted.getSetting.mockReturnValue(JSON.stringify({ theme: 'dark', language: 'en' }))

    registerLocaleHandlers(mockI18n, rebuildMenu)
    const getHandler = (ipcMain.handle as any).mock.calls.find(
      ([channel]: [string]) => channel === 'locale:get'
    )[1]
    const setHandler = (ipcMain.handle as any).mock.calls.find(
      ([channel]: [string]) => channel === 'locale:set'
    )[1]

    await setHandler({}, 'tr')

    expect(hoisted.setStoredLocale).toHaveBeenCalledWith('tr')
    expect(hoisted.setSetting).toHaveBeenCalledTimes(1)
    expect(hoisted.setSetting.mock.calls[0][0]).toEqual({})
    expect(hoisted.setSetting.mock.calls[0][1]).toBe('general')
    expect(JSON.parse(hoisted.setSetting.mock.calls[0][2])).toMatchObject({
      theme: 'dark',
      language: 'tr'
    })
    expect(hoisted.writePreferences).toHaveBeenCalledWith('/vault', { language: 'tr' })
    expect(mockI18n.changeLanguage).toHaveBeenCalledWith('tr')
    expect(rebuildMenu).toHaveBeenCalledWith('tr')
    expect(send).toHaveBeenCalledWith('locale:changed', 'tr')
    expect(getHandler()).toBe('tr')
  })

  it('updates locale without a vault database for the vault picker window', async () => {
    const send = vi.fn()
    const mockI18n = { changeLanguage: vi.fn(), language: 'en' } as any
    const rebuildMenu = vi.fn()
    hoisted.windows = [{ isDestroyed: () => false, webContents: { send } }]
    hoisted.getCurrentVaultPath.mockReturnValue(null)
    hoisted.getDatabase.mockImplementation(() => {
      throw new Error('Database not initialized')
    })

    registerLocaleHandlers(mockI18n, rebuildMenu)
    const getHandler = (ipcMain.handle as any).mock.calls.find(
      ([channel]: [string]) => channel === 'locale:get'
    )[1]
    const setHandler = (ipcMain.handle as any).mock.calls.find(
      ([channel]: [string]) => channel === 'locale:set'
    )[1]

    await setHandler({}, 'tr')

    expect(hoisted.setStoredLocale).toHaveBeenCalledWith('tr')
    expect(hoisted.setSetting).not.toHaveBeenCalled()
    expect(hoisted.writePreferences).not.toHaveBeenCalled()
    expect(mockI18n.changeLanguage).toHaveBeenCalledWith('tr')
    expect(rebuildMenu).toHaveBeenCalledWith('tr')
    expect(send).toHaveBeenCalledWith('locale:changed', 'tr')
    expect(getHandler()).toBe('tr')
  })

  it('persists nothing when the language switch itself fails', async () => {
    // #given a locale bundle that fails to load
    const send = vi.fn()
    const mockI18n = {
      changeLanguage: vi.fn().mockRejectedValue(new Error('bundle unavailable')),
      language: 'en'
    } as any
    const rebuildMenu = vi.fn()
    hoisted.windows = [{ isDestroyed: () => false, webContents: { send } }]

    registerLocaleHandlers(mockI18n, rebuildMenu)
    const getHandler = (ipcMain.handle as any).mock.calls.find(
      ([channel]: [string]) => channel === 'locale:get'
    )[1]
    const setHandler = (ipcMain.handle as any).mock.calls.find(
      ([channel]: [string]) => channel === 'locale:set'
    )[1]

    // #when the switch is attempted
    await expect(setHandler({}, 'tr')).rejects.toThrow('bundle unavailable')

    // #then nothing is written, so config.json, the store and the DB cannot end
    // up holding a language the app never actually switched to
    expect(hoisted.setStoredLocale).not.toHaveBeenCalled()
    expect(hoisted.writePreferences).not.toHaveBeenCalled()
    expect(hoisted.setSetting).not.toHaveBeenCalled()

    // #and the runtime stays on the old locale, in agreement with what is stored
    expect(rebuildMenu).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(getHandler()).toBe('en')
  })
})
