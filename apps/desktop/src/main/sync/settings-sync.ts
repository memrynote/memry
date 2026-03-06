import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '@memry/db-schema/data-schema'
import { settings } from '@memry/db-schema/schema/settings'
import type { VectorClock } from '@memry/contracts/sync-api'
import { utcNow } from '@memry/shared/utc'
import type {
  SyncedSettings,
  FieldClockMap,
  SettingsSyncPayload
} from '@memry/contracts/settings-sync'
import { compare, merge, increment } from './vector-clock'
import { SyncQueueManager } from './queue'
import { createLogger } from '../lib/logger'

type DrizzleDb = BetterSQLite3Database<typeof schema>

const log = createLogger('SettingsSync')

const SETTINGS_KEY = 'synced_settings'
const CLOCKS_KEY = 'synced_settings_clocks'

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
  constructor(deps: SettingsSyncDeps) {
    this.db = deps.db
    this.queue = deps.queue
  }

  updateField(fieldPath: string, value: unknown, deviceId: string): void {
    const current = this.loadSettings()
    const clocks = this.loadClocks()

    const parts = fieldPath.split('.')
    this.setNestedValue(current, parts, value)

    clocks[fieldPath] = increment(clocks[fieldPath] ?? {}, deviceId)

    this.saveSettings(current)
    this.saveClocks(clocks)

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

  mergeRemote(remote: SettingsSyncPayload): void {
    const local = this.loadSettings()
    const localClocks = this.loadClocks()
    const remoteClocks = remote.fieldClocks

    const allFields = new Set([...Object.keys(localClocks), ...Object.keys(remoteClocks)])

    for (const field of allFields) {
      const localClock = localClocks[field] ?? {}
      const remoteClock = remoteClocks[field] ?? {}
      const cmp = compare(localClock, remoteClock)

      if (cmp === 'before' || cmp === 'equal') {
        const remoteValue = this.getNestedValue(remote.settings, field.split('.'))
        if (remoteValue !== undefined) {
          this.setNestedValue(local, field.split('.'), remoteValue)
        }
        localClocks[field] = remoteClock
      } else if (cmp === 'concurrent') {
        const remoteCombined = this.getMaxTick(remoteClock)
        const localCombined = this.getMaxTick(localClock)
        if (remoteCombined > localCombined) {
          const remoteValue = this.getNestedValue(remote.settings, field.split('.'))
          if (remoteValue !== undefined) {
            this.setNestedValue(local, field.split('.'), remoteValue)
          }
        }
        localClocks[field] = merge(localClock, remoteClock)
      }
    }

    this.saveSettings(local)
    this.saveClocks(localClocks)
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

  private setNestedValue(obj: Record<string, unknown>, parts: string[], value: unknown): void {
    let current = obj
    for (let i = 0; i < parts.length - 1; i++) {
      if (current[parts[i]] === undefined || typeof current[parts[i]] !== 'object') {
        current[parts[i]] = {}
      }
      current = current[parts[i]] as Record<string, unknown>
    }
    current[parts[parts.length - 1]] = value
  }

  private getNestedValue(obj: Record<string, unknown>, parts: string[]): unknown {
    let current: unknown = obj
    for (const part of parts) {
      if (current === null || current === undefined || typeof current !== 'object') {
        return undefined
      }
      current = (current as Record<string, unknown>)[part]
    }
    return current
  }

  private getMaxTick(clock: VectorClock): number {
    const ticks = Object.values(clock)
    return ticks.length > 0 ? Math.max(...ticks) : 0
  }
}
