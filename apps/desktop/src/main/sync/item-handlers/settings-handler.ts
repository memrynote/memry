import { BrowserWindow } from 'electron'
import { SettingsChannels } from '@memry/contracts/ipc-channels'
import { SettingsSyncPayloadSchema } from '@memry/contracts/settings-sync'
import type { SettingsSyncPayload, SyncedSettings } from '@memry/contracts/settings-sync'
import type { VectorClock } from '@memry/contracts/sync-api'
import type { SyncQueueManager } from '../queue'
import { getSettingsSyncManager } from '../settings-sync'
import { writePreferences } from '../../vault/vault-preferences'
import { writeCacheFromPreferences } from '../../vault/settings-cache'
import { readPreferences } from '../../vault/vault-preferences'
import { getCurrentVaultPath } from '../../store'
import { getDatabase } from '../../database'
import { createLogger } from '../../lib/logger'
import type { SyncItemHandler, ApplyContext, ApplyResult, DrizzleDb } from './types'

const log = createLogger('SettingsHandler')

// Standalone (not extending BaseItemHandler): settings handler overrides every
// concrete method — apply/delete/fetchLocal/seedUnclocked — because settings
// live in config.json + prefs cache, not in a dedicated sync DB table like all
// other items. Inheritance would give us nothing but indirection.
class SettingsHandler implements SyncItemHandler<SettingsSyncPayload> {
  readonly type = 'settings' as const
  readonly schema = SettingsSyncPayloadSchema

  applyUpsert(
    _ctx: ApplyContext,
    _itemId: string,
    data: SettingsSyncPayload,
    _clock: VectorClock
  ): ApplyResult {
    const manager = getSettingsSyncManager()
    if (!manager) {
      log.warn('SettingsSyncManager not initialized, skipping settings apply')
      return 'skipped'
    }

    manager.mergeRemote(data)

    propagateMergedSettings(manager.getSettings())

    return 'applied'
  }

  applyDelete(_ctx: ApplyContext, _itemId: string, _clock?: VectorClock): 'applied' | 'skipped' {
    return 'skipped'
  }

  fetchLocal(_db: DrizzleDb, _itemId: string): Record<string, unknown> | undefined {
    return undefined
  }

  seedUnclocked(_db: DrizzleDb, _deviceId: string, _queue: SyncQueueManager): number {
    return 0
  }
}

export const settingsHandler = new SettingsHandler()

function propagateMergedSettings(merged: SyncedSettings): void {
  let vaultPath: string | null = null
  try {
    vaultPath = getCurrentVaultPath()
  } catch {
    // Store may not be initialized
  }

  if (vaultPath) {
    try {
      const prefsUpdate: Record<string, unknown> = {}

      if (merged.general) {
        const g = merged.general
        if (g.theme) prefsUpdate.theme = g.theme
        if (g.fontSize) prefsUpdate.fontSize = g.fontSize
        if (g.fontFamily) prefsUpdate.fontFamily = g.fontFamily
        if (g.accentColor) prefsUpdate.accentColor = g.accentColor
        if (g.language) prefsUpdate.language = g.language
        if (g.createInSelectedFolder !== undefined) {
          prefsUpdate.createInSelectedFolder = g.createInSelectedFolder
        }
      }

      if (merged.editor) {
        prefsUpdate.editor = { ...merged.editor }
      }

      if (Object.keys(prefsUpdate).length > 0) {
        writePreferences(vaultPath, prefsUpdate)
      }

      const prefs = readPreferences(vaultPath)

      try {
        const db = getDatabase()
        writeCacheFromPreferences(db, prefs)
      } catch {
        // DB may not be available
      }
    } catch (err) {
      log.warn('Failed to propagate merged settings to config.json:', err)
    }
  }

  broadcastSettingsChanged(merged)
}

function broadcastSettingsChanged(merged: SyncedSettings): void {
  let windows: Electron.BrowserWindow[]
  try {
    windows = BrowserWindow.getAllWindows()
  } catch {
    return
  }
  if (windows.length === 0) return

  if (merged.general) {
    for (const win of windows) {
      win.webContents.send(SettingsChannels.events.CHANGED, {
        key: 'general',
        value: merged.general
      })
    }
  }

  if (merged.editor) {
    for (const win of windows) {
      win.webContents.send(SettingsChannels.events.CHANGED, {
        key: 'editor',
        value: merged.editor
      })
    }
  }
}
