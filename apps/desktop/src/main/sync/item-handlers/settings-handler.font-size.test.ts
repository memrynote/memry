import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { SettingsSyncPayload } from '@memry/contracts/settings-sync'
import type { VectorClock } from '@memry/contracts/sync-api'
import type { ApplyContext, DrizzleDb } from '@memry/sync-client/item-handlers/types'

const mockMergeRemote = vi.fn()
const mockGetSettings = vi.fn((): Record<string, unknown> => ({}))
vi.mock('@memry/sync-client/settings-sync', () => ({
  getSettingsSyncManager: vi.fn(() => ({
    mergeRemote: mockMergeRemote,
    getSettings: mockGetSettings,
    updateField: vi.fn(),
    enqueueCreate: vi.fn(),
    enqueueUpdate: vi.fn(),
    enqueueDelete: vi.fn()
  }))
}))

const mockGetCurrentVaultPath = vi.fn((): string | null => null)
vi.mock('../../store', () => ({
  getCurrentVaultPath: () => mockGetCurrentVaultPath(),
  setStoredLocale: vi.fn()
}))

vi.mock('../../vault/settings-cache', () => ({
  writeCacheFromPreferences: vi.fn()
}))

vi.mock('../../tray', () => ({
  applyTraySetting: vi.fn()
}))

vi.mock('../../lib/window-broadcast', () => ({
  broadcastToAllWindows: vi.fn()
}))

vi.mock('../../ipc/locale-handler', () => ({
  applyLocale: vi.fn(() => Promise.resolve())
}))

vi.mock('../../database', () => ({
  getDatabase: vi.fn(() => {
    throw new Error('no database in this test')
  })
}))

import { getMemryDir } from '../../vault/init'
import { readPreferences, writePreferences } from '../../vault/vault-preferences'
import { settingsHandler } from './settings-handler'

// Nothing here is mocked below the handler: writePreferences and
// readPreferences run for real against a temp vault, so these assert the pixel
// size a device actually renders at after an inbound merge, not the argument
// some intermediate call happened to be handed.
describe('font size across two devices', () => {
  const ctx: ApplyContext = {
    db: {} as DrizzleDb,
    deviceId: 'device-B',
    vaultId: 'vault-1'
  }
  const clock: VectorClock = { 'device-B': 1 }

  let vaultPath: string

  beforeEach(() => {
    vi.clearAllMocks()
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-font-size-'))
    fs.mkdirSync(getMemryDir(vaultPath), { recursive: true })
    mockGetCurrentVaultPath.mockReturnValue(vaultPath)

    // Device A dragged the slider to 22, which writes the pair atomically.
    writePreferences(vaultPath, { fontSizePx: 22, fontSize: 'large' })
  })

  afterEach(() => {
    fs.rmSync(vaultPath, { recursive: true, force: true })
  })

  it('#given an older device pushes only the legacy bucket #then its change wins', () => {
    // Device B runs a build from before the slider, so its "Small" carries no
    // fontSizePx at all and the merge leaves 22 sitting next to 'small'.
    mockGetSettings.mockReturnValue({
      general: { fontSize: 'small', fontSizePx: 22 }
    })
    const data: SettingsSyncPayload = {
      settings: { general: { fontSize: 'small' } },
      fieldClocks: { 'general.fontSize': { 'device-A': 2, 'device-B': 1 } }
    }

    settingsHandler.applyUpsert(ctx, 'synced_settings', data, clock)

    expect(readPreferences(vaultPath).fontSizePx).toBe(14)
  })

  it('#given an inbound merge about another setting entirely #then the slider value survives', () => {
    mockGetSettings.mockReturnValue({
      general: { theme: 'light', fontSize: 'large', fontSizePx: 22 }
    })
    const data: SettingsSyncPayload = {
      settings: { general: { theme: 'light' } },
      fieldClocks: { 'general.theme': { 'device-B': 1 } }
    }

    settingsHandler.applyUpsert(ctx, 'synced_settings', data, clock)

    expect(readPreferences(vaultPath).fontSizePx).toBe(22)
  })
})
