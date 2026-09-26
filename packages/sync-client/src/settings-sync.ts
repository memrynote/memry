import { eq } from 'drizzle-orm'
import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import { settings } from '@memry/db-schema/schema/settings'
import { utcNow } from '@memry/shared/utc'
import type {
  SyncedSettings,
  FieldClockMap,
  SettingsSyncPayload
} from '@memry/contracts/settings-sync'
import { increment } from '@memry/sync-client/vector-clock'
import { SyncQueueManager } from './queue'
import { mergeSettingsPayloads, setSettingsPath } from './settings-merge'
import { createLogger } from './logging'
import {
  SETTINGS_SYNC_CLOCKS_KEY,
  SETTINGS_SYNC_SETTINGS_KEY
} from '@memry/sync-client/settings-sync-keys'

const log = createLogger('SettingsSync')

const SETTINGS_KEY = SETTINGS_SYNC_SETTINGS_KEY
const CLOCKS_KEY = SETTINGS_SYNC_CLOCKS_KEY

interface SettingsSyncDeps {
  db: DrizzleDb
  queue: SyncQueueManager
  getDeviceId: () => string | null
}

let instance: SettingsSyncManager | null = null

export function initSettingsSyncManager(deps: SettingsSyncDeps): SettingsSyncManager {
  instance = new SettingsSyncManager(deps)
  return instance
}

export function getSettingsSyncManager(): SettingsSyncManager | null {
  return instance
}

export function resetSettingsSyncManager(): void {
  instance = null
}

export class SettingsSyncManager {
  private db: DrizzleDb
  private queue: SyncQueueManager
  private getDeviceId: () => string | null

  constructor(deps: SettingsSyncDeps) {
    this.db = deps.db
    this.queue = deps.queue
    this.getDeviceId = deps.getDeviceId
  }

  enqueueCreate(_itemId = 'synced_settings'): void {
    this.enqueueCurrentState()
  }

  enqueueUpdate(_itemId = 'synced_settings'): void {
    this.enqueueCurrentState()
  }

  enqueueDelete(_itemId = 'synced_settings'): void {
    // Settings currently sync as a singleton update payload only.
  }

  /**
   * Returns false, writing nothing, when no device is registered (#2287). The
   * clock needs a real device id: every device used to tick the shared key
   * `local`, so concurrent edits compared equal and one was silently dropped.
   * A stored `local` component is left in place — it already reached peers,
   * so unlike `_offline` it is shared causal history, not this device's.
   */
  updateField(fieldPath: string, value: unknown): boolean {
    const deviceId = this.getDeviceId()
    if (!deviceId) {
      log.warn('No current device, skipping synced settings write', { fieldPath })
      return false
    }

    const current = this.loadSettings()
    const clocks = this.loadClocks()

    setSettingsPath(current, fieldPath.split('.'), value)

    clocks[fieldPath] = increment(clocks[fieldPath] ?? {}, deviceId)

    this.saveSettings(current)
    this.saveClocks(clocks)
    this.enqueueCurrentState()
    return true
  }

  /**
   * Chapter 06 §6.9.0 (#2383): each clocked path goes to §6.3's rule. A winner
   * with no value at the path keeps the local value; removal waits for #2183.
   */
  mergeRemote(remote: SettingsSyncPayload): void {
    const merged = mergeSettingsPayloads(
      { settings: this.loadSettings(), fieldClocks: this.loadClocks() },
      remote
    )

    this.saveSettings(merged.settings)
    this.saveClocks(merged.fieldClocks)

    // §6.5.2 P3 (#2287): the union clock must reach the server. Settings have
    // no buildPushPayload, so a queued row is pushed as frozen; without this a
    // device that kept its own value on a concurrent tie holds it alone while
    // the server keeps the peer's, and the two never converge.
    if (merged.requeue) this.enqueueCurrentState()
  }

  getPayload(): SettingsSyncPayload {
    return {
      settings: this.loadSettings(),
      fieldClocks: this.loadClocks()
    }
  }

  getSettings(): SyncedSettings {
    return this.loadSettings()
  }

  private loadSettings(): SyncedSettings {
    const row = this.db.select().from(settings).where(eq(settings.key, SETTINGS_KEY)).get()
    if (!row) return {}
    try {
      return JSON.parse(row.value) as SyncedSettings
    } catch {
      return {}
    }
  }

  private loadClocks(): FieldClockMap {
    const row = this.db.select().from(settings).where(eq(settings.key, CLOCKS_KEY)).get()
    if (!row) return {}
    try {
      return JSON.parse(row.value) as FieldClockMap
    } catch {
      return {}
    }
  }

  private saveSettings(value: SyncedSettings): void {
    const json = JSON.stringify(value)
    const now = utcNow()
    this.db
      .insert(settings)
      .values({ key: SETTINGS_KEY, value: json, modifiedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value: json, modifiedAt: now } })
      .run()
  }

  private saveClocks(value: FieldClockMap): void {
    const json = JSON.stringify(value)
    const now = utcNow()
    this.db
      .insert(settings)
      .values({ key: CLOCKS_KEY, value: json, modifiedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value: json, modifiedAt: now } })
      .run()
  }

  private enqueueCurrentState(): void {
    try {
      const payload = JSON.stringify(this.getPayload())
      this.queue.enqueue({
        type: 'settings',
        itemId: 'synced_settings',
        operation: 'update',
        payload,
        priority: 0
      })
    } catch (err) {
      log.error('Failed to enqueue settings sync', err)
    }
  }
}
