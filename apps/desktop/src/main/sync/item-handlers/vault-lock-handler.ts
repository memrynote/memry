import { eq, isNull } from 'drizzle-orm'
import { vaultLocks } from '@memry/db-schema/schema/vault-locks'
import {
  VaultLockSyncPayloadSchema,
  type VaultLockSyncPayload
} from '@memry/contracts/sync-payloads'
import { isVaultLockTargetKind } from '@memry/contracts/vault-locks-api'
import type { VectorClock } from '@memry/contracts/sync-api'
import { utcNow } from '@memry/shared/utc'
import type { SyncQueueManager } from '@memry/sync-client/queue'
import { increment } from '@memry/sync-client/vector-clock'
import { createLogger } from '../../lib/logger'
import { BaseItemHandler } from '@memry/sync-client/item-handlers/base-handler'
import type { ApplyContext, ApplyResult, DrizzleDb } from '@memry/sync-client/item-handlers/types'
import { onRemoteVaultLockApplied } from '../../vault-locks/service'

const log = createLogger('VaultLockHandler')

/** A folder unlocked by this apply, so its non-note files are made writable again. */
function unlockedFolderOf(kind: string, target: string, locked: boolean): string | undefined {
  return kind === 'folder' && !locked ? target : undefined
}

class VaultLockHandler extends BaseItemHandler<VaultLockSyncPayload> {
  readonly type = 'vault_lock' as const
  readonly schema = VaultLockSyncPayloadSchema

  applyUpsert(
    ctx: ApplyContext,
    itemId: string,
    data: VaultLockSyncPayload,
    clock: VectorClock
  ): ApplyResult {
    // A kind this build does not know (a newer peer) is skipped and the local
    // row, if any, left alone: guessing what it locks could block writes or
    // leave a target the peer meant to protect writable.
    if (data.targetKind !== undefined && !isVaultLockTargetKind(data.targetKind)) {
      log.warn('Skipping remote vault lock, unknown target kind', { itemId })
      return 'skipped'
    }

    const result = ctx.db.transaction((tx): { result: ApplyResult; unlocked?: string } => {
      const existing = tx.select().from(vaultLocks).where(eq(vaultLocks.id, itemId)).get()
      const remoteClock = Object.keys(clock).length > 0 ? clock : (data.clock ?? {})
      const now = utcNow()

      if (existing) {
        const resolution = this.resolveUpsertClock(ctx, itemId, existing.clock, remoteClock, data)
        if (resolution.action === 'skip') {
          log.info('Skipping remote vault lock update, local is newer', { itemId })
          return { result: 'skipped' }
        }
        if (resolution.action === 'merge') {
          log.warn('Concurrent vault lock change, using last-write-wins', { itemId })
        }
        const locked = data.locked ?? existing.locked
        tx.update(vaultLocks)
          .set({
            locked,
            clock: resolution.mergedClock,
            syncedAt: now,
            updatedAt: data.updatedAt ?? now
          })
          .where(eq(vaultLocks.id, itemId))
          .run()
        return {
          result: resolution.action === 'merge' ? 'conflict' : 'applied',
          unlocked: unlockedFolderOf(existing.targetKind, existing.target, locked)
        }
      }

      // Every payload field is optional, so `{}` parses; a row needs all three.
      if (!data.targetKind || !data.target || data.locked === undefined) {
        log.warn('Skipping remote vault lock insert, payload is incomplete', { itemId })
        return { result: 'skipped' }
      }

      tx.insert(vaultLocks)
        .values({
          id: itemId,
          targetKind: data.targetKind,
          target: data.target,
          locked: data.locked,
          clock: remoteClock,
          syncedAt: now,
          createdAt: data.createdAt ?? now,
          updatedAt: data.updatedAt ?? now
        })
        .run()
      return { result: 'applied' }
    })

    if (result.result !== 'skipped') onRemoteVaultLockApplied(result.unlocked)
    return result.result
  }

  /** Locks are never deleted by this build; a delete from elsewhere unlocks. */
  applyDelete(ctx: ApplyContext, itemId: string, clock?: VectorClock): 'applied' | 'skipped' {
    const existing = ctx.db.select().from(vaultLocks).where(eq(vaultLocks.id, itemId)).get()
    if (!existing) return 'skipped'

    if (clock && existing.clock) {
      const resolution = this.resolveDeleteClock(existing.clock, clock)
      if (resolution.skip) {
        log.info('Skipping remote vault lock delete, local is ahead of the tombstone', { itemId })
        return 'skipped'
      }
    }

    ctx.db.delete(vaultLocks).where(eq(vaultLocks.id, itemId)).run()
    onRemoteVaultLockApplied(unlockedFolderOf(existing.targetKind, existing.target, false))
    return 'applied'
  }

  fetchLocal(db: DrizzleDb, itemId: string): Record<string, unknown> | undefined {
    return db.select().from(vaultLocks).where(eq(vaultLocks.id, itemId)).get() as
      Record<string, unknown> | undefined
  }

  buildPushPayload(
    db: DrizzleDb,
    itemId: string,
    _deviceId: string,
    _operation: string
  ): string | null {
    const row = db.select().from(vaultLocks).where(eq(vaultLocks.id, itemId)).get()
    if (!row) return null
    const payload: VaultLockSyncPayload = {
      targetKind: row.targetKind,
      target: row.target,
      locked: row.locked,
      clock: row.clock ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }
    return JSON.stringify(payload)
  }

  markPushSynced(db: DrizzleDb, itemId: string): void {
    db.update(vaultLocks).set({ syncedAt: utcNow() }).where(eq(vaultLocks.id, itemId)).run()
  }

  /** Carries locks made before sync was set up onto the account. */
  seedUnclocked(db: DrizzleDb, deviceId: string, queue: SyncQueueManager): number {
    const items = db.select().from(vaultLocks).where(isNull(vaultLocks.clock)).all()
    for (const item of items) {
      const clock = increment({}, deviceId)
      db.update(vaultLocks).set({ clock }).where(eq(vaultLocks.id, item.id)).run()
      queue.enqueue({
        type: 'vault_lock',
        itemId: item.id,
        operation: 'create',
        payload: JSON.stringify({ ...item, clock }),
        priority: 0
      })
    }
    return items.length
  }
}

export const vaultLockHandler = new VaultLockHandler()
