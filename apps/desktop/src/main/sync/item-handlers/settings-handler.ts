import { SettingsChannels } from '@memry/contracts/ipc-channels'
import { SettingsSyncPayloadSchema } from '@memry/contracts/settings-sync'
import type { SettingsSyncPayload, SyncedSettings } from '@memry/contracts/settings-sync'
import type { VectorClock } from '@memry/contracts/sync-api'
import { LocaleSchema } from '@memry/contracts/locale-api'
import type { SyncQueueManager } from '@memry/sync-client/queue'
import { getSettingsSyncManager } from '@memry/sync-client/settings-sync'
import { applyLocale } from '../../ipc/locale-handler'
import { writePreferences } from '../../vault/vault-preferences'
import { writeCacheFromPreferences } from '../../vault/settings-cache'
import { readPreferences } from '../../vault/vault-preferences'
import { getCurrentVaultPath } from '../../store'
import { getDatabase } from '../../database'
import { getSetting, setSetting, deleteSetting } from '../../database/queries/settings'
import { INBOX_REVIEW_LAST_NOTIFIED_KEY } from '../../inbox/review-reminder-constants'
import {
  JOURNAL_DEFAULT_TEMPLATE_KEY,
  JOURNAL_WEEKDAY_TEMPLATES_KEY,
  parseWeekdayTemplateMap,
  sanitizeWeekdayTemplateMap,
  type WeekdayTemplateMap
} from '../../settings/journal-template-keys'
import { SIDEBAR_SORT_SETTINGS_KEY } from '../../settings/sidebar-sort-store'
import { SIDEBAR_SECTION_ORDER_SETTINGS_KEY } from '../../settings/sidebar-section-order-store'
import { SIDEBAR_NAV_COLLAPSED_SETTINGS_KEY } from '../../settings/sidebar-nav-store'
import { createLogger } from '../../lib/logger'
import { broadcastToAllWindows } from '../../lib/window-broadcast'
import type {
  SyncItemHandler,
  ApplyContext,
  ApplyResult,
  DrizzleDb
} from '@memry/sync-client/item-handlers/types'

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

  // Journal template settings live in the local data DB as flat `journal.*`
  // rows (not the portable config.json prefs), so they persist regardless of
  // whether a vault path resolves — same reasoning as inbox above.
  let journalBroadcast: JournalBroadcastPayload | null = null
  if (merged.journal) {
    try {
      journalBroadcast = propagateMergedJournalSettings(merged.journal)
    } catch (err) {
      log.warn('Failed to propagate merged journal settings:', err)
    }
  }

  // Sidebar sort modes live only in the local data DB, same as inbox: persist
  // before the vault-path guard so a merge landing while the path is null still
  // reaches the DB the sidebar reads. Merging per surface (not replacing the
  // whole map) keeps a remote change to one section from clobbering a local
  // change to another — the field clocks are already per surface.
  if (merged.sidebar?.sortModes) {
    try {
      const db = getDatabase()
      const raw = getSetting(db, SIDEBAR_SORT_SETTINGS_KEY)
      const current = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      const next = { ...current, ...merged.sidebar.sortModes }
      setSetting(db, SIDEBAR_SORT_SETTINGS_KEY, JSON.stringify(next))
      broadcastToAllWindows(SettingsChannels.events.CHANGED, {
        key: SIDEBAR_SORT_SETTINGS_KEY,
        value: next
      })
    } catch (err) {
      log.warn('Failed to propagate merged sidebar sort modes:', err)
    }
  }

  // Same local-DB-only story as the sort modes above. Replaced rather than
  // merged: the order is one list under one field clock, so the merge already
  // picked a winner — splicing the two here would invent a third order.
  if (merged.sidebar?.sectionOrder) {
    try {
      const db = getDatabase()
      const next = merged.sidebar.sectionOrder.filter((id) => typeof id === 'string')
      setSetting(db, SIDEBAR_SECTION_ORDER_SETTINGS_KEY, JSON.stringify(next))
      broadcastToAllWindows(SettingsChannels.events.CHANGED, {
        key: SIDEBAR_SECTION_ORDER_SETTINGS_KEY,
        value: next
      })
    } catch (err) {
      log.warn('Failed to propagate merged sidebar section order:', err)
    }
  }

  // Local-DB-only again, and tested with `typeof` rather than truthiness: the
  // whole point of the flag is that `false` is a real value, so a truthy guard
  // would drop every "expand it again" merge and strand the other device with
  // its nav hidden.
  if (typeof merged.sidebar?.navCollapsed === 'boolean') {
    try {
      const db = getDatabase()
      const next = merged.sidebar.navCollapsed
      setSetting(db, SIDEBAR_NAV_COLLAPSED_SETTINGS_KEY, JSON.stringify(next))
      broadcastToAllWindows(SettingsChannels.events.CHANGED, {
        key: SIDEBAR_NAV_COLLAPSED_SETTINGS_KEY,
        value: next
      })
    } catch (err) {
      log.warn('Failed to propagate merged sidebar nav collapsed flag:', err)
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
        // Not a truthiness check: '' is how a device says "custom font cleared",
        // and dropping it would leave the other device's font stuck on.
        if (g.customFontFamily !== undefined) {
          prefsUpdate.customFontFamily = g.customFontFamily
        }
        if (g.accentColor) prefsUpdate.accentColor = g.accentColor
        if (g.language) prefsUpdate.language = g.language
        if (g.createInSelectedFolder !== undefined) {
          prefsUpdate.createInSelectedFolder = g.createInSelectedFolder
        }
        if (g.openPagesInNewTab !== undefined) {
          prefsUpdate.openPagesInNewTab = g.openPagesInNewTab
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

  broadcastSettingsChanged(merged, journalBroadcast)

  applySyncedLocale(merged.general?.language)
}

interface JournalBroadcastPayload {
  defaultTemplate?: string | null
  weekdayTemplates?: WeekdayTemplateMap
}

/**
 * Write inbound journal template settings to the local data DB and return what
 * the renderer should be told.
 *
 * The weekday map is *merged*, never replaced: settings sync only carries
 * fields that have been written since this device learned to sync them
 * (`seedUnclocked` returns 0 for settings, so nothing is back-filled). A day
 * this device set before that point has no clock and never left the machine —
 * overwriting the whole map with the synced subset would silently drop it.
 *
 * A `null` day is a real value, not an absence: it means "this day was cleared,
 * fall back to the default template", and it has to survive the merge to beat a
 * stale remote id.
 */
function propagateMergedJournalSettings(
  journal: NonNullable<SyncedSettings['journal']>
): JournalBroadcastPayload {
  const db = getDatabase()
  const payload: JournalBroadcastPayload = {}

  if (journal.defaultTemplate !== undefined) {
    if (journal.defaultTemplate === null) {
      deleteSetting(db, JOURNAL_DEFAULT_TEMPLATE_KEY)
    } else {
      setSetting(db, JOURNAL_DEFAULT_TEMPLATE_KEY, journal.defaultTemplate)
    }
    payload.defaultTemplate = journal.defaultTemplate
  }

  if (journal.weekdayTemplates) {
    const current = parseWeekdayTemplateMap(getSetting(db, JOURNAL_WEEKDAY_TEMPLATES_KEY))
    const incoming = sanitizeWeekdayTemplateMap(journal.weekdayTemplates)
    const next = { ...current, ...incoming }
    setSetting(db, JOURNAL_WEEKDAY_TEMPLATES_KEY, JSON.stringify(next))
    payload.weekdayTemplates = next
  }

  return payload
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
function broadcastSettingsChanged(
  merged: SyncedSettings,
  journal: JournalBroadcastPayload | null
): void {
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

    // Broadcast the DB-authoritative merge, not `merged.journal`: the synced
    // view omits days this device set before settings sync covered them, and a
    // shallow patch would replace the renderer's whole map with that subset.
    if (journal && Object.keys(journal).length > 0) {
      broadcastToAllWindows(SettingsChannels.events.CHANGED, {
        key: 'journal',
        value: journal
      })
    }
  } catch (err) {
    log.warn('Failed to broadcast synced settings change:', err)
  }
}
