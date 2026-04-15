import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SettingsSyncPayload } from '@memry/contracts/settings-sync'
import type { VectorClock } from '@memry/contracts/sync-api'
import type { ApplyContext, DrizzleDb } from './types'

const mockMergeRemote = vi.fn()
const mockGetSettings = vi.fn(() => ({}))
vi.mock('../settings-sync', () => ({
  getSettingsSyncManager: vi.fn(() => ({
    mergeRemote: mockMergeRemote,
    getSettings: mockGetSettings
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
    spellCheck: true,
    autoSaveDelay: 1000,
    showWordCount: false,
    toolbarMode: 'floating'
  }
}))
vi.mock('../../vault/settings-cache', () => ({
  writeCacheFromPreferences: (...args: unknown[]) => mockWriteCacheFromPreferences(...args)
}))
vi.mock('../../vault/vault-preferences', () => ({
  writePreferences: (...args: unknown[]) => mockWritePreferences(...args),
  readPreferences: (...args: unknown[]) => mockReadPreferences(...args)
}))

const mockGetCurrentVaultPath = vi.fn(() => '/test/vault')
vi.mock('../../store', () => ({
  getCurrentVaultPath: () => mockGetCurrentVaultPath()
}))

const mockSend = vi.fn()
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => [{ webContents: { send: mockSend } }])
  }
}))

vi.mock('../../database', () => ({
  getDatabase: vi.fn(() => ({}))
}))

import { settingsHandler } from './settings-handler'

describe('settingsHandler.applyUpsert', () => {
  const ctx: ApplyContext = {
    db: {} as unknown as DrizzleDb,
    emit: vi.fn()
  }
  const clock: VectorClock = { 'device-B': 3 }

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetCurrentVaultPath.mockReturnValue('/test/vault')
    mockGetSettings.mockReturnValue({
      general: { theme: 'dark', fontSize: 'medium' },
      editor: { width: 'wide' }
    })
  })

  it('#given remote settings #when applyUpsert called #then calls mergeRemote', () => {
    const data: SettingsSyncPayload = {
      settings: { general: { theme: 'dark' } },
      fieldClocks: { 'general.theme': { 'device-B': 3 } }
    }

    const result = settingsHandler.applyUpsert(ctx, 'synced_settings', data, clock)

    expect(result).toBe('applied')
    expect(mockMergeRemote).toHaveBeenCalledWith(data)
  })

  it('#given vault path available #when applyUpsert called #then writes to config.json', () => {
    const data: SettingsSyncPayload = {
      settings: { general: { theme: 'dark' } },
      fieldClocks: { 'general.theme': { 'device-B': 3 } }
    }

    settingsHandler.applyUpsert(ctx, 'synced_settings', data, clock)

    expect(mockWritePreferences).toHaveBeenCalled()
    const callArgs = mockWritePreferences.mock.calls[0]
    expect(callArgs[0]).toBe('/test/vault')
  })

  it('#given merged settings with general fields #then writes portable general to config.json', () => {
    mockGetSettings.mockReturnValue({
      general: { theme: 'dark', fontSize: 'large', language: 'tr' }
    })

    const data: SettingsSyncPayload = {
      settings: { general: { theme: 'dark' } },
      fieldClocks: { 'general.theme': { 'device-B': 3 } }
    }

    settingsHandler.applyUpsert(ctx, 'synced_settings', data, clock)

    const prefsArg = mockWritePreferences.mock.calls[0][1]
    expect(prefsArg.theme).toBe('dark')
    expect(prefsArg.fontSize).toBe('large')
    expect(prefsArg.language).toBe('tr')
  })

  it('#given merged settings with editor fields #then writes editor to config.json', () => {
    mockGetSettings.mockReturnValue({
      editor: { width: 'wide', spellCheck: false }
    })

    const data: SettingsSyncPayload = {
      settings: { editor: { width: 'wide' } },
      fieldClocks: { 'editor.width': { 'device-B': 2 } }
    }

    settingsHandler.applyUpsert(ctx, 'synced_settings', data, clock)

    const prefsArg = mockWritePreferences.mock.calls[0][1]
    expect(prefsArg.editor.width).toBe('wide')
    expect(prefsArg.editor.spellCheck).toBe(false)
  })

  it('#given applyUpsert called #then broadcasts CHANGED events for general + editor', () => {
    const data: SettingsSyncPayload = {
      settings: { general: { theme: 'dark' } },
      fieldClocks: { 'general.theme': { 'device-B': 3 } }
    }

    settingsHandler.applyUpsert(ctx, 'synced_settings', data, clock)

    const changedCalls = mockSend.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('changed')
    )
    expect(changedCalls.length).toBeGreaterThanOrEqual(1)
  })

  it('#given no vault path #then skips config.json write but still merges', () => {
    mockGetCurrentVaultPath.mockReturnValue(null)

    const data: SettingsSyncPayload = {
      settings: { general: { theme: 'dark' } },
      fieldClocks: { 'general.theme': { 'device-B': 3 } }
    }

    const result = settingsHandler.applyUpsert(ctx, 'synced_settings', data, clock)

    expect(result).toBe('applied')
    expect(mockMergeRemote).toHaveBeenCalledWith(data)
    expect(mockWritePreferences).not.toHaveBeenCalled()
  })
})
