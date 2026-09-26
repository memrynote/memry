import { describe, it, expect, vi, beforeEach } from 'vitest'
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
import { settingsHandler } from './settings-handler'

const ctx: ApplyContext = {
  db: {} as DrizzleDb,
  emit: (channel, data) => mocks.broadcast(channel, data)
}
const clock: VectorClock = { 'device-B': 3 }

const broadcastFor = (key: string): unknown =>
  mocks.broadcast.mock.calls.find(
    (call: unknown[]) =>
      call[0] === SettingsChannels.events.CHANGED && (call[1] as { key?: string }).key === key
  )?.[1]

describe.each([
  { field: 'notesFirst', key: 'sidebar.notesFirst' },
  { field: 'showFiles', key: 'sidebar.showFiles' }
] as const)('settingsHandler.applyUpsert — sidebar.$field', ({ field, key }) => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.rows.clear()
    mocks.getDatabase.mockReturnValue({})
  })

  // Both values, and `false` in particular: it is what puts folders first again
  // or hides files, and a truthy guard would drop exactly that merge.
  it.each([true, false])('#given a remote %s #then persists it and tells the renderer', (value) => {
    mocks.rows.set(key, JSON.stringify(!value))
    mocks.getSettings.mockReturnValue({ sidebar: { [field]: value } })

    const data: SettingsSyncPayload = {
      settings: { sidebar: { [field]: value } },
      fieldClocks: { [key]: { 'device-B': 3 } }
    }

    expect(settingsHandler.applyUpsert(ctx, 'synced_settings', data, clock)).toBe('applied')

    expect(mocks.rows.get(key)).toBe(JSON.stringify(value))
    expect(broadcastFor(key)).toEqual({ key, value })
  })

  // A payload from a build that predates the toggle carries no field at all.
  it('#given a remote merge without the flag #then leaves the stored row alone', () => {
    mocks.rows.set(key, 'true')
    mocks.getSettings.mockReturnValue({ general: { theme: 'light' } })

    const data: SettingsSyncPayload = {
      settings: { general: { theme: 'light' } },
      fieldClocks: { 'general.theme': { 'device-B': 3 } }
    }

    settingsHandler.applyUpsert(ctx, 'synced_settings', data, clock)

    expect(mocks.rows.get(key)).toBe('true')
    expect(broadcastFor(key)).toBeUndefined()
  })

  it('#given the flag cannot be written #then swallows it and still applies', () => {
    mocks.getSettings.mockReturnValue({ sidebar: { [field]: true } })
    mocks.getDatabase.mockImplementation(() => {
      throw new Error('vault closed')
    })

    const data: SettingsSyncPayload = {
      settings: { sidebar: { [field]: true } },
      fieldClocks: { [key]: { 'device-B': 9 } }
    }

    expect(settingsHandler.applyUpsert(ctx, 'synced_settings', data, clock)).toBe('applied')
    expect(broadcastFor(key)).toBeUndefined()
  })
})
