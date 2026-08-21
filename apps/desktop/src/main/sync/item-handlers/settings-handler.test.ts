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
  readPreferences: (...args: unknown[]) => mockReadPreferences(...args)
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

import { LocaleChannels, SettingsChannels } from '@memry/contracts/ipc-channels'
import { getDatabase } from '../../database'
import { getSetting, setSetting } from '../../database/queries/settings'
import { INBOX_REVIEW_LAST_NOTIFIED_KEY } from '../../inbox/review-reminder-constants'
import {
  createTestDatabase,
  cleanupTestDatabase,
  asClientDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
// Deliberately the real module, not a mock: the defect these tests cover was
// that a synced language never reached this runtime path, so stubbing
// applyLocale() would assert nothing about the thing that was broken.
import { getActiveLocale, registerLocaleHandlers } from '../../ipc/locale-handler'
import { settingsHandler } from './settings-handler'

describe('settingsHandler.applyUpsert', () => {
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
    mockGetSettings.mockReturnValue({
      general: { theme: 'dark', fontSize: 'medium' },
      editor: { width: 'wide' }
    })
  })

  afterEach(() => {
    cleanupTestDatabase(testDb)
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

  // #1644 — the preference must reach the other device's config.json, and
  // `false` is the value that matters: a truthiness check would drop it.
  it('#given a synced openPagesInNewTab=false #then writes it to config.json', () => {
    mockGetSettings.mockReturnValue({
      general: { openPagesInNewTab: false }
    })

    const data: SettingsSyncPayload = {
      settings: { general: { openPagesInNewTab: false } },
      fieldClocks: { 'general.openPagesInNewTab': { 'device-B': 2 } }
    }

    settingsHandler.applyUpsert(ctx, 'synced_settings', data, clock)

    const prefsArg = mockWritePreferences.mock.calls[0][1]
    expect(prefsArg.openPagesInNewTab).toBe(false)
  })

  // Same truthiness trap as openPagesInNewTab above: '' is how the other device
  // says "custom font cleared", and dropping it would leave this device's
  // interface stuck on a font the user already removed.
  it('#given a synced customFontFamily cleared to empty #then writes it to config.json', () => {
    mockGetSettings.mockReturnValue({
      general: { customFontFamily: '' }
    })

    const data: SettingsSyncPayload = {
      settings: { general: { customFontFamily: '' } },
      fieldClocks: { 'general.customFontFamily': { 'device-B': 4 } }
    }

    settingsHandler.applyUpsert(ctx, 'synced_settings', data, clock)

    const prefsArg = mockWritePreferences.mock.calls[0][1]
    expect(prefsArg.customFontFamily).toBe('')
  })

  it('#given merged settings with editor fields #then writes editor to config.json', () => {
    mockGetSettings.mockReturnValue({
      editor: { width: 'wide' }
    })

    const data: SettingsSyncPayload = {
      settings: { editor: { width: 'wide' } },
      fieldClocks: { 'editor.width': { 'device-B': 2 } }
    }

    settingsHandler.applyUpsert(ctx, 'synced_settings', data, clock)

    const prefsArg = mockWritePreferences.mock.calls[0][1]
    expect(prefsArg.editor.width).toBe('wide')
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

  // The order lives only in the local data DB (like the sort modes), so an
  // inbound merge has to write it there — a broadcast alone would show the new
  // order until the next restart and then quietly lose it.
  it('#given a remote sidebar section order #then persists it and tells the renderer', () => {
    setSetting(testDb.db, 'sidebar.sectionOrder', JSON.stringify(['collections', 'tags']))
    mockGetSettings.mockReturnValue({
      sidebar: { sectionOrder: ['tags', 'collections', 'projects'] }
    })

    const data: SettingsSyncPayload = {
      settings: { sidebar: { sectionOrder: ['tags', 'collections', 'projects'] } },
      fieldClocks: { 'sidebar.sectionOrder': { 'device-B': 3 } }
    }

    settingsHandler.applyUpsert(ctx, 'synced_settings', data, clock)

    expect(JSON.parse(getSetting(testDb.db, 'sidebar.sectionOrder') as string)).toEqual([
      'tags',
      'collections',
      'projects'
    ])
    const broadcast = mockSend.mock.calls.find(
      (call: unknown[]) =>
        call[0] === SettingsChannels.events.CHANGED &&
        (call[1] as { key?: string })?.key === 'sidebar.sectionOrder'
    )
    expect(broadcast?.[1]).toEqual({
      key: 'sidebar.sectionOrder',
      value: ['tags', 'collections', 'projects']
    })
  })

  it('#given a remote merge with no sidebar order #then leaves the stored order alone', () => {
    setSetting(testDb.db, 'sidebar.sectionOrder', JSON.stringify(['tags']))
    mockGetSettings.mockReturnValue({ general: { theme: 'light' } })

    const data: SettingsSyncPayload = {
      settings: { general: { theme: 'light' } },
      fieldClocks: { 'general.theme': { 'device-B': 3 } }
    }

    settingsHandler.applyUpsert(ctx, 'synced_settings', data, clock)

    expect(JSON.parse(getSetting(testDb.db, 'sidebar.sectionOrder') as string)).toEqual(['tags'])
  })

  it('#given remote inbox reminder time change #then clears the local last-notified guard', () => {
    setSetting(
      testDb.db,
      'inbox',
      JSON.stringify({ reviewReminderEnabled: true, reviewReminderTime: '18:00' })
    )
    setSetting(testDb.db, INBOX_REVIEW_LAST_NOTIFIED_KEY, '2026-07-17')
    mockGetSettings.mockReturnValue({ inbox: { reviewReminderTime: '09:00' } })

    const data: SettingsSyncPayload = {
      settings: { inbox: { reviewReminderTime: '09:00' } },
      fieldClocks: { 'inbox.reviewReminderTime': { 'device-B': 3 } }
    }

    settingsHandler.applyUpsert(ctx, 'synced_settings', data, clock)

    expect(getSetting(testDb.db, INBOX_REVIEW_LAST_NOTIFIED_KEY)).toBeNull()
  })

  it('#given remote inbox merge with no actual schedule change #then leaves the guard intact', () => {
    setSetting(
      testDb.db,
      'inbox',
      JSON.stringify({ reviewReminderEnabled: true, reviewReminderTime: '18:00' })
    )
    setSetting(testDb.db, INBOX_REVIEW_LAST_NOTIFIED_KEY, '2026-07-17')
    mockGetSettings.mockReturnValue({ inbox: { reviewReminderTime: '18:00' } })

    const data: SettingsSyncPayload = {
      settings: { inbox: { reviewReminderTime: '18:00' } },
      fieldClocks: { 'inbox.reviewReminderTime': { 'device-B': 3 } }
    }

    settingsHandler.applyUpsert(ctx, 'synced_settings', data, clock)

    expect(getSetting(testDb.db, INBOX_REVIEW_LAST_NOTIFIED_KEY)).toBe('2026-07-17')
  })
})

// A language changed on device B used to reach config.json and the settings
// cache but never the runtime: device A kept the old UI language, the old
// native menu and a stale activeLocale until restart. These drive the real
// locale-handler so the assertions are about the runtime effects, not about
// applyLocale() merely having been called.
describe('settingsHandler.applyUpsert — synced locale', () => {
  const ctx: ApplyContext = {
    db: {} as unknown as DrizzleDb,
    emit: vi.fn()
  }
  const clock: VectorClock = { 'device-B': 7 }
  let testDb: TestDatabaseResult
  let i18n: { changeLanguage: ReturnType<typeof vi.fn>; language: string }
  let rebuildMenu: ReturnType<typeof vi.fn>

  // applySyncedLocale() fires applyLocale() without awaiting it (the handler
  // stays synchronous), so the runtime effects land a microtask later.
  const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

  const upsert = (settings: Record<string, unknown>): string => {
    mockGetSettings.mockReturnValue(settings as never)
    const data = {
      settings,
      fieldClocks: { 'general.language': { 'device-B': 7 } }
    } as unknown as SettingsSyncPayload
    return settingsHandler.applyUpsert(ctx, 'synced_settings', data, clock)
  }

  const localeChangedSends = (): unknown[][] =>
    mockSend.mock.calls.filter((c: unknown[]) => c[0] === LocaleChannels.Changed)

  const settingsChangedSends = (): unknown[][] =>
    mockSend.mock.calls.filter((c: unknown[]) => c[0] === SettingsChannels.events.CHANGED)

  /** Re-registering resets locale-handler's module-level activeLocale. */
  const registerWithActiveLocale = (locale: string): void => {
    i18n = { changeLanguage: vi.fn().mockResolvedValue(undefined), language: locale }
    rebuildMenu = vi.fn()
    registerLocaleHandlers(i18n as never, rebuildMenu as never)
  }

  beforeEach(() => {
    vi.clearAllMocks()
    testDb = createTestDatabase()
    vi.mocked(getDatabase).mockReturnValue(asClientDb(testDb.db))
    mockGetCurrentVaultPath.mockReturnValue('/test/vault')
    registerWithActiveLocale('en')
  })

  afterEach(() => {
    cleanupTestDatabase(testDb)
  })

  it('#given inbound general.language differs from the active locale #then swaps i18n, rebuilds the native menu and tells the renderer', async () => {
    upsert({ general: { theme: 'dark', language: 'tr' } })
    await settle()

    expect(i18n.changeLanguage).toHaveBeenCalledWith('tr')
    expect(rebuildMenu).toHaveBeenCalledWith('tr')
    expect(localeChangedSends()).toEqual([[LocaleChannels.Changed, 'tr']])
    // LocaleChannels.Get answers from activeLocale; if it stayed 'en' the
    // renderer would keep asking for the pre-sync language.
    expect(getActiveLocale()).toBe('tr')
  })

  it('#given inbound general.language differs #then persists it to the store, the vault prefs and the general settings row', async () => {
    setSetting(testDb.db, 'general', JSON.stringify({ theme: 'dark', language: 'en' }))

    upsert({ general: { theme: 'dark', language: 'tr' } })
    await settle()

    expect(mockSetStoredLocale).toHaveBeenCalledWith('tr')
    // The locale write is the last one: propagateMergedSettings writes the
    // portable prefs first, then the apply path writes the language.
    expect(mockWritePreferences).toHaveBeenLastCalledWith('/test/vault', { language: 'tr' })
    const persisted = JSON.parse(getSetting(testDb.db, 'general') as string)
    expect(persisted).toMatchObject({ theme: 'dark', language: 'tr' })
  })

  it('#given inbound language equals the active locale #then does not re-apply it', async () => {
    registerWithActiveLocale('tr')

    upsert({ general: { theme: 'light', language: 'tr' } })
    await settle()

    expect(i18n.changeLanguage).not.toHaveBeenCalled()
    expect(rebuildMenu).not.toHaveBeenCalled()
    expect(localeChangedSends()).toEqual([])
    expect(mockSetStoredLocale).not.toHaveBeenCalled()
    expect(getActiveLocale()).toBe('tr')
    // The rest of the merge still lands — this is a locale no-op, not a
    // whole-item no-op.
    expect(settingsChangedSends().length).toBeGreaterThan(0)
    expect(mockWritePreferences).toHaveBeenCalledTimes(1)
    expect(mockWritePreferences.mock.calls[0][1]).toMatchObject({ theme: 'light' })
  })

  it('#given inbound settings carry no language #then leaves the locale alone but still applies the other settings', async () => {
    const result = upsert({
      general: { theme: 'light', fontSize: 'large' },
      editor: { width: 'wide' }
    })
    await settle()

    expect(result).toBe('applied')
    expect(i18n.changeLanguage).not.toHaveBeenCalled()
    expect(rebuildMenu).not.toHaveBeenCalled()
    expect(localeChangedSends()).toEqual([])
    expect(mockSetStoredLocale).not.toHaveBeenCalled()
    expect(getActiveLocale()).toBe('en')

    expect(mockWritePreferences).toHaveBeenCalledTimes(1)
    const prefsArg = mockWritePreferences.mock.calls[0][1]
    expect(prefsArg).toMatchObject({ theme: 'light', fontSize: 'large' })
    expect(prefsArg).not.toHaveProperty('language')
    expect(prefsArg.editor).toEqual({ width: 'wide' })
    expect(settingsChangedSends().map((c) => (c[1] as { key: string }).key)).toEqual([
      'general',
      'editor'
    ])
  })

  it('#given a synced locale is applied #then nothing is pushed back onto the sync queue', async () => {
    upsert({ general: { language: 'ja' } })
    await settle()

    // Guard the guard: without this the assertions below would pass on a
    // build where the locale is never applied at all.
    expect(i18n.changeLanguage).toHaveBeenCalledWith('ja')

    expect(mockUpdateField).not.toHaveBeenCalled()
    expect(mockEnqueueCreate).not.toHaveBeenCalled()
    expect(mockEnqueueUpdate).not.toHaveBeenCalled()
    expect(mockEnqueueDelete).not.toHaveBeenCalled()
  })

  it('#given an unsupported language (older app version wrote config.json) #then degrades without throwing or touching the runtime locale', async () => {
    let result: string | undefined
    expect(() => {
      result = upsert({ general: { theme: 'dark', language: 'klingon' } })
    }).not.toThrow()
    await settle()

    expect(result).toBe('applied')
    expect(i18n.changeLanguage).not.toHaveBeenCalled()
    expect(rebuildMenu).not.toHaveBeenCalled()
    expect(localeChangedSends()).toEqual([])
    expect(mockSetStoredLocale).not.toHaveBeenCalled()
    expect(getActiveLocale()).toBe('en')
    // Non-locale settings from the same item still apply.
    expect(settingsChangedSends().length).toBeGreaterThan(0)
  })

  it('#given an empty-string language #then is treated as absent rather than parsed', async () => {
    const result = upsert({ general: { theme: 'dark', language: '' } })
    await settle()

    expect(result).toBe('applied')
    expect(i18n.changeLanguage).not.toHaveBeenCalled()
    expect(getActiveLocale()).toBe('en')
  })

  it('#given a region-tagged locale such as zh-CN #then applies it verbatim', async () => {
    upsert({ general: { language: 'zh-CN' } })
    await settle()

    expect(i18n.changeLanguage).toHaveBeenCalledWith('zh-CN')
    expect(rebuildMenu).toHaveBeenCalledWith('zh-CN')
    expect(getActiveLocale()).toBe('zh-CN')
  })

  it('#given i18n.changeLanguage rejects #then the pull still reports applied and the active locale does not lie', async () => {
    i18n.changeLanguage.mockRejectedValue(new Error('missing bundle'))

    const result = upsert({ general: { language: 'de' } })
    await settle()

    expect(result).toBe('applied')
    // The switch was attempted — without this the assertions below would also
    // hold on a build that never applies a synced locale at all.
    expect(i18n.changeLanguage).toHaveBeenCalledWith('de')
    expect(rebuildMenu).not.toHaveBeenCalled()
    expect(localeChangedSends()).toEqual([])
    // activeLocale is only advanced after a successful switch, so
    // LocaleChannels.Get keeps reporting the language actually in use.
    expect(getActiveLocale()).toBe('en')
  })

  it('#given no vault path (vault picker window) #then a synced locale still goes live', async () => {
    mockGetCurrentVaultPath.mockReturnValue(null)

    upsert({ general: { language: 'fr' } })
    await settle()

    expect(mockWritePreferences).not.toHaveBeenCalled()
    expect(i18n.changeLanguage).toHaveBeenCalledWith('fr')
    expect(rebuildMenu).toHaveBeenCalledWith('fr')
    expect(getActiveLocale()).toBe('fr')
  })
})
