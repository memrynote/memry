import { SettingsChannels } from '@memry/contracts/ipc-channels'
import { SettingsSyncPayloadSchema } from '@memry/contracts/settings-sync'
import type { SettingsSyncPayload, SyncedSettings } from '@memry/contracts/settings-sync'
import type { VectorClock } from '@memry/contracts/sync-api'
import { LocaleSchema } from '@memry/contracts/locale-api'
import type { SyncQueueManager } from '../queue'
import { getSettingsSyncManager } from '../settings-sync'
import { applyLocale } from '../../ipc/locale-handler'
import { writePreferences } from '../../vault/vault-preferences'
import { writeCacheFromPreferences } from '../../vault/settings-cache'
import { readPreferences } from '../../vault/vault-preferences'
import { getCurrentVaultPath } from '../../store'
import { getDatabase } from '../../database'
import { getSetting, setSetting, deleteSetting } from '../../database/queries/settings'
import { INBOX_REVIEW_LAST_NOTIFIED_KEY } from '../../inbox/review-reminder-constants'
import { createLogger } from '../../lib/logger'
import { broadcastToAllWindows } from '../../lib/window-broadcast'
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
  // Inbox settings live only in the local data DB (not portable config.json
  // prefs), so persist them regardless of whether a vault path is resolvable.
  // Otherwise a merge that lands while getCurrentVaultPath() is transiently null
  // would broadcast the new schedule to the renderer but never write it to the
  // DB the review scheduler reads, losing the change until the next local write.
  if (merged.inbox) {
    try {
      const db = getDatabase()
      const raw = getSetting(db, 'inbox')
      const current = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      const scheduleChanged =
        ('reviewReminderTime' in merged.inbox &&
          merged.inbox.reviewReminderTime !== current.reviewReminderTime) ||
        ('reviewReminderEnabled' in merged.inbox &&
          merged.inbox.reviewReminderEnabled !== current.reviewReminderEnabled)
      setSetting(db, 'inbox', JSON.stringify({ ...current, ...merged.inbox }))
      // A reminder-time/enabled change synced in from another device should
      // re-arm this device's once-per-day guard too, mirroring the local
      // writeInboxReviewSettings() clear.
      if (scheduleChanged) {
        deleteSetting(db, INBOX_REVIEW_LAST_NOTIFIED_KEY)
      }
    } catch (err) {
      log.warn('Failed to propagate merged inbox settings:', err)
    }
  }

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

  applySyncedLocale(merged.general?.language)
}

// A language changed on another device has to take the same runtime path as a
// local switch, or this device keeps the old UI language and old native menu
// until restart and locale-handler's `activeLocale` (what LocaleChannels.Get
// returns) drifts away from what was just persisted. applyLocale() performs no
// sync enqueue, so applying an inbound locale cannot push a write back out.
function applySyncedLocale(candidate: string | undefined): void {
  if (!candidate) return

  const parsed = LocaleSchema.safeParse(candidate)
  if (!parsed.success) {
    log.warn('Ignoring unsupported language from synced settings:', candidate)
    return
  }

  applyLocale(parsed.data).catch((err) => {
    log.warn('Failed to apply synced locale:', err)
  })
}

/**
 * This runs inside the sync item's DB transaction (#935, #1000): anything that
 * escapes here rolls back an item that was already applied. broadcastToAllWindows
 * skips destroyed windows and contains a per-window send failure, but
 * BrowserWindow.getAllWindows() itself can still throw during app teardown —
 * which the previous hand-rolled loop tolerated. Keep tolerating it, but log it
 * rather than dropping it silently.
 */
function broadcastSettingsChanged(merged: SyncedSettings): void {
  try {
    if (merged.general) {
      broadcastToAllWindows(SettingsChannels.events.CHANGED, {
        key: 'general',
        value: merged.general
      })
    }

    if (merged.editor) {
      broadcastToAllWindows(SettingsChannels.events.CHANGED, {
        key: 'editor',
        value: merged.editor
      })
    }

    if (merged.inbox) {
      broadcastToAllWindows(SettingsChannels.events.CHANGED, {
        key: 'inbox',
        value: merged.inbox
      })
    }
  } catch (err) {
    log.warn('Failed to broadcast synced settings change:', err)
  }
}
