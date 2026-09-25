import type { ZodType } from 'zod'
import type { SyncItemType, VectorClock } from '@memry/contracts/sync-api'
import type { SyncQueueManager } from '../queue'
import type {
  ApplyContext,
  ApplyResult,
  DrizzleDb,
  SyncItemHandler,
  ClockResolution
} from './types'
import { resolveClockConflict } from './types'
import { valuesEqual } from '../field-merge'

export abstract class BaseItemHandler<T> implements SyncItemHandler<T> {
  abstract readonly type: SyncItemType
  abstract readonly schema: ZodType<T>

  abstract applyUpsert(ctx: ApplyContext, itemId: string, data: T, clock: VectorClock): ApplyResult

  applyDelete(_ctx: ApplyContext, _itemId: string, _clock?: VectorClock): 'applied' | 'skipped' {
    return 'skipped'
  }

  fetchLocal(_db: DrizzleDb, _itemId: string): Record<string, unknown> | undefined {
    return undefined
  }

  seedUnclocked(_db: DrizzleDb, _deviceId: string, _queue: SyncQueueManager): number {
    return 0
  }

  buildPushPayload?(
    db: DrizzleDb,
    itemId: string,
    deviceId: string,
    operation: string,
    vaultKey?: Uint8Array
  ): string | null

  markPushSynced?(db: DrizzleDb, itemId: string): void

  protected resolveClock(
    localClock: VectorClock | null | undefined,
    remoteClock: VectorClock
  ): ClockResolution {
    return resolveClockConflict(localClock, remoteClock)
  }

  /**
   * `resolveClock` for an incoming upsert. An EQUAL clock whose payload is
   * identical to the local row skips (#2294, protocol 06 §6.5.2 P4) and reports
   * `identical`, so a handler can still restore local-only state (missing
   * files) that the skipped apply would have fetched. Equal with different
   * content applies.
   */
  protected resolveUpsertClock(
    ctx: ApplyContext,
    itemId: string,
    localClock: VectorClock | null | undefined,
    remoteClock: VectorClock,
    remote: T
  ): ClockResolution & { identical: boolean } {
    let identical = false
    const resolution = resolveClockConflict(
      localClock,
      remoteClock,
      () => (identical = this.matchesLocalPayload(ctx.db, itemId, remote))
    )
    identical &&= resolution.action === 'skip'
    if (identical) this.markSyncedIfDirty(ctx.db, itemId)
    return { ...resolution, identical }
  }

  /**
   * True when the local row's push payload, parsed by this handler's schema,
   * is canonically equal (protocol 06 §6.4.2) to the incoming one: the row this
   * device would push is the row being pulled. The payload is what a peer
   * receives (P2 rebuilds it from the live row), so it is the comparison an
   * equal-clock skip has to pass (#2294). A type that cannot build it never
   * matches and keeps applying. No device id: building must not stamp a clock.
   */
  protected matchesLocalPayload(db: DrizzleDb, itemId: string, remote: T): boolean {
    try {
      const local = this.buildPushPayload?.(db, itemId, '', 'update')
      if (local == null) return false
      const parsed = this.schema.safeParse(JSON.parse(local))
      return parsed.success && valuesEqual(parsed.data, remote)
    } catch {
      return false
    }
  }

  /**
   * An identical equal-clock row is exactly the server's copy, so it is synced.
   * Stamp that only while the row still looks dirty to the startup sweep
   * (`syncedAt` NULL, or older than the last edit): a push whose ack was lost
   * would otherwise be re-pushed under a new clock, which the apply this skip
   * replaces used to prevent. A clean row is left untouched (#2294).
   */
  private markSyncedIfDirty(db: DrizzleDb, itemId: string): void {
    if (!this.markPushSynced) return
    const row = this.fetchLocal(db, itemId)
    if (!row) return
    const synced = toEpochMs(row.syncedAt ?? row.lastSyncedAt)
    const edited = toEpochMs(row.modifiedAt ?? row.updatedAt)
    if (synced !== null && (edited === null || edited <= synced)) return
    this.markPushSynced(db, itemId)
  }

  /**
   * Delete wins over a concurrent write — the client mirror of the server's
   * `shouldRejectResurrection` (#2198). A device that edited an item before it
   * saw the delete has a clock concurrent with the tombstone: its push is
   * refused forever with `SYNC_DELETE_WINS` and written nowhere, so skipping
   * the pulled tombstone as well left that one device holding a ghost copy of
   * an item deleted everywhere else. Only local state that happens strictly
   * after the tombstone may keep the item; a concurrent local edit loses.
   *
   * `mergedClock` is what the tombstone must be stamped with, so a later edit
   * resolves against the delete identically on every device.
   */
  protected resolveDeleteClock(
    localClock: VectorClock | null | undefined,
    remoteClock: VectorClock
  ): { skip: boolean; mergedClock: VectorClock } {
    const resolution = this.resolveClock(localClock, remoteClock)
    return { skip: resolution.action === 'skip', mergedClock: resolution.mergedClock }
  }
}

function toEpochMs(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value
  const ms = Date.parse(String(value))
  return Number.isNaN(ms) ? null : ms
}
