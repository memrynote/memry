import { eq } from 'drizzle-orm'
import { syncState } from '@shared/db/schema/sync-state'
import { createLogger } from '../../lib/logger'
import { EVENT_CHANNELS } from '@shared/contracts/ipc-events'
import type { SecurityWarningEvent, QuarantinedItemInfo } from '@shared/contracts/ipc-events'
import type { SyncContext, QuarantineEntry } from './sync-context'
import { SYNC_STATE_KEYS, QUARANTINE_MAX_ATTEMPTS } from './sync-context'

const log = createLogger('QuarantineManager')

export class QuarantineManager {
  private quarantinedItems = new Map<string, QuarantineEntry>()
  private ctx: SyncContext

  constructor(ctx: SyncContext) {
    this.ctx = ctx
  }

  quarantineItem(itemId: string, itemType: string, signerDeviceId: string, error: string): void {
    const existing = this.quarantinedItems.get(itemId)
    const attemptCount = existing ? existing.attemptCount + 1 : 1
    const permanent = attemptCount >= QUARANTINE_MAX_ATTEMPTS

    this.quarantinedItems.set(itemId, {
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
      const entries = JSON.parse(val) as QuarantineEntry[]
      for (const entry of entries) {
        this.quarantinedItems.set(entry.itemId, entry)
      }
      if (entries.length > 0) {
        log.info('Loaded persisted quarantine state', { count: entries.length })
      }
    } catch (err) {
      log.warn('Failed to load quarantine state', {
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  isQuarantined(itemId: string): boolean {
    const entry = this.quarantinedItems.get(itemId)
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
      const value = JSON.stringify(permanent)
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
