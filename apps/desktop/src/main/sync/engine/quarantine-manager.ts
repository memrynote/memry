import { eq } from 'drizzle-orm'
import { syncState } from '@memry/db-schema/schema/sync-state'
import { createLogger } from '../../lib/logger'
import { EVENT_CHANNELS } from '@memry/contracts/ipc-events'
import type { SecurityWarningEvent, QuarantinedItemInfo } from '@memry/contracts/ipc-events'
import { trackMainError } from '../../telemetry/diagnostics'
import type { SyncContext, QuarantineEntry } from './sync-context'
import {
  SYNC_STATE_KEYS,
  QUARANTINE_MAX_ATTEMPTS,
  QUARANTINE_ENTRY_TTL_MS,
  itemRefKey
} from './sync-context'

const log = createLogger('QuarantineManager')

export class QuarantineManager {
  private quarantinedItems = new Map<string, QuarantineEntry>()
  private ctx: SyncContext

  constructor(ctx: SyncContext) {
    this.ctx = ctx
  }

  quarantineItem(itemId: string, itemType: string, signerDeviceId: string, error: string): void {
    const existing = this.quarantinedItems.get(itemRefKey(itemType, itemId))
    const attemptCount = existing ? existing.attemptCount + 1 : 1
    const permanent = attemptCount >= QUARANTINE_MAX_ATTEMPTS

    this.quarantinedItems.set(itemRefKey(itemType, itemId), {
      itemId,
      itemType,
      signerDeviceId,
      failedAt: Date.now(),
      attemptCount,
      lastError: error
    })

    log.warn('SECURITY_AUDIT: Signature verification failed', {
      itemId,
      itemType,
      signerDeviceId,
      attemptCount,
      permanent
    })

    // Fleet-wide quarantine rate — the user gets a toast, but without this
    // Error Tracking never sees signature failures (tampering or key drift).
    trackMainError('sync', 'item_quarantined', new Error(error))

    this.ctx.deps.emitToRenderer(EVENT_CHANNELS.SECURITY_WARNING, {
      itemId,
      itemType,
      signerDeviceId,
      reason: 'signature_verification_failed',
      attemptCount,
      permanent
    } satisfies SecurityWarningEvent)

    if (permanent) {
      this.persistState()
    }
  }

  loadState(): void {
    try {
      const rows = this.ctx.deps.db
        .select()
        .from(syncState)
        .where(eq(syncState.key, SYNC_STATE_KEYS.QUARANTINED_ITEMS))
        .all()
      const val = rows[0]?.value
      if (!val) return
      const parsed = JSON.parse(val) as
        | QuarantineEntry[]
        | { v: number; entries: QuarantineEntry[] }
      // v1 (bare array) was written by the id-keyed era: colliding item types
      // shared one entry whose attemptCount and itemType were jointly mangled,
      // so a legacy entry can brand the WRONG type permanent. Discard v1
      // wholesale — a genuinely broken item re-quarantines within
      // QUARANTINE_MAX_ATTEMPTS pulls, a healthy one flows again immediately.
      if (Array.isArray(parsed)) {
        log.info('Discarded legacy id-keyed quarantine state', { dropped: parsed.length })
        this.persistState()
        return
      }
      const entries = parsed.entries ?? []
      // Expire stale entries: the server rows that earned a quarantine may
      // have been repaired or purged since. If an item is still broken it
      // re-quarantines within QUARANTINE_MAX_ATTEMPTS pulls, so dropping old
      // entries is safe — keeping them forever is what blocked healthy items
      // indefinitely after the 2026-07-18 server-side cleanup.
      const now = Date.now()
      const live = entries.filter((entry) => now - entry.failedAt < QUARANTINE_ENTRY_TTL_MS)
      for (const entry of live) {
        this.quarantinedItems.set(itemRefKey(entry.itemType, entry.itemId), entry)
      }
      if (live.length > 0) {
        log.info('Loaded persisted quarantine state', { count: live.length })
      }
      if (live.length < entries.length) {
        log.info('Expired stale quarantine entries', { dropped: entries.length - live.length })
        this.persistState()
      }
    } catch (err) {
      log.warn('Failed to load quarantine state', {
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  isQuarantined(itemId: string, itemType: string): boolean {
    const entry = this.quarantinedItems.get(itemRefKey(itemType, itemId))
    if (!entry) return false
    return entry.attemptCount >= QUARANTINE_MAX_ATTEMPTS
  }

  getQuarantinedItems(): QuarantinedItemInfo[] {
    return Array.from(this.quarantinedItems.values()).map((entry) => ({
      ...entry,
      permanent: entry.attemptCount >= QUARANTINE_MAX_ATTEMPTS
    }))
  }

  clear(): void {
    this.quarantinedItems.clear()
  }

  private persistState(): void {
    try {
      const permanent = Array.from(this.quarantinedItems.values()).filter(
        (e) => e.attemptCount >= QUARANTINE_MAX_ATTEMPTS
      )
      const value = JSON.stringify({ v: 2, entries: permanent })
      this.ctx.deps.db
        .insert(syncState)
        .values({ key: SYNC_STATE_KEYS.QUARANTINED_ITEMS, value, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: syncState.key,
          set: { value, updatedAt: new Date() }
        })
        .run()
    } catch (err) {
      log.warn('Failed to persist quarantine state', {
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }
}
