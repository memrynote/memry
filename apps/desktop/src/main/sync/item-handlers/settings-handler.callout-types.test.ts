import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SettingsSyncPayload } from '@memry/contracts/settings-sync'
import type { VectorClock } from '@memry/contracts/sync-api'
import type { ApplyContext, DrizzleDb } from '@memry/sync-client/item-handlers/types'

const mocks = vi.hoisted(() => ({
  rows: new Map<string, string>(),
  getSettings: vi.fn((): Record<string, unknown> => ({})),
  broadcast: vi.fn(),
  getDatabase: vi.fn((): unknown => ({}))
}))

vi.mock('@memry/sync-client/settings-sync', () => ({
  getSettingsSyncManager: vi.fn(() => ({
    mergeRemote: vi.fn(),
    getSettings: mocks.getSettings,
    updateField: vi.fn(),
    enqueueCreate: vi.fn(),
    enqueueUpdate: vi.fn(),
    enqueueDelete: vi.fn()
  }))
}))

// No vault path: the sidebar flags are local-DB-only and must land without one.
vi.mock('../../store', () => ({
  getCurrentVaultPath: () => null,
  setStoredLocale: vi.fn()
}))

vi.mock('../../vault/settings-cache', () => ({
  writeCacheFromPreferences: vi.fn()
}))

vi.mock('../../tray', () => ({
  applyTraySetting: vi.fn()
}))

vi.mock('../../lib/window-broadcast', () => ({
  broadcastToAllWindows: mocks.broadcast
}))

vi.mock('../../ipc/locale-handler', () => ({
  applyLocale: vi.fn(() => Promise.resolve())
}))

vi.mock('../../database', () => ({
  getDatabase: mocks.getDatabase
}))

vi.mock('../../database/queries/settings', () => ({
  getSetting: (_db: unknown, key: string) => mocks.rows.get(key) ?? null,
  setSetting: (_db: unknown, key: string, value: string) => {
    mocks.rows.set(key, value)
  },
  deleteSetting: (_db: unknown, key: string) => {
    mocks.rows.delete(key)
  }
}))

import { SettingsChannels } from '@memry/contracts/ipc-channels'
import { readCalloutRun, setCalloutTypeDefinitions } from '@memry/editor-schema/blocks'
import { CALLOUT_TYPES_SETTINGS_KEY } from '../../settings/callout-types-store'
import { settingsHandler } from './settings-handler'

const ctx: ApplyContext = {
  db: {} as DrizzleDb,
  emit: (channel, data) => mocks.broadcast(channel, data)
}
const clock: VectorClock = { 'device-B': 3 }
const mytype = { label: 'My type', color: '#ff8800', icon: 'star' }
const claimsMytype = (): boolean => readCalloutRun(['> [!mytype]', '> body'], 0, true) !== null

describe('settingsHandler.applyUpsert — editor.calloutTypes (#3207)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.rows.clear()
    mocks.getDatabase.mockReturnValue({})
  })
  afterEach(() => setCalloutTypeDefinitions([]))

  it('stores a synced type, teaches the parser and tells the renderer', () => {
    const settings = { editor: { calloutTypes: { mytype, gone: null } } }
    mocks.getSettings.mockReturnValue(settings)
    const data: SettingsSyncPayload = {
      settings,
      fieldClocks: { 'editor.calloutTypes.mytype': { 'device-B': 3 } }
    }

    expect(settingsHandler.applyUpsert(ctx, 'synced_settings', data, clock)).toBe('applied')

    expect(claimsMytype()).toBe(true)
    expect(JSON.parse(mocks.rows.get(CALLOUT_TYPES_SETTINGS_KEY) as string)).toEqual({
      mytype: { name: 'mytype', ...mytype }
    })
    expect(mocks.broadcast).toHaveBeenCalledWith(SettingsChannels.events.CHANGED, {
      key: CALLOUT_TYPES_SETTINGS_KEY,
      value: [{ name: 'mytype', ...mytype }]
    })
  })

  it('removes a type another device deleted', () => {
    mocks.rows.set(
      CALLOUT_TYPES_SETTINGS_KEY,
      JSON.stringify({ mytype: { name: 'mytype', ...mytype } })
    )
    const settings = { editor: { calloutTypes: { mytype: null } } }
    mocks.getSettings.mockReturnValue(settings)

    settingsHandler.applyUpsert(
      ctx,
      'synced_settings',
      { settings, fieldClocks: { 'editor.calloutTypes.mytype': { 'device-B': 4 } } },
      clock
    )

    expect(claimsMytype()).toBe(false)
    expect(JSON.parse(mocks.rows.get(CALLOUT_TYPES_SETTINGS_KEY) as string)).toEqual({})
  })

  it('does not leak the types into the editor broadcast', () => {
    const settings: SettingsSyncPayload['settings'] = {
      editor: { width: 'full', calloutTypes: { mytype } }
    }
    mocks.getSettings.mockReturnValue(settings)

    settingsHandler.applyUpsert(
      ctx,
      'synced_settings',
      { settings, fieldClocks: { 'editor.width': { 'device-B': 3 } } },
      clock
    )

    const editorBroadcast = mocks.broadcast.mock.calls.find(
      (call: unknown[]) => (call[1] as { key?: string }).key === 'editor'
    )?.[1]
    expect(editorBroadcast).toEqual({ key: 'editor', value: { width: 'full' } })
  })
})
