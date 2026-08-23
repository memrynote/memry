import type { ZodType } from 'zod'
import type { VectorClock, SyncItemType } from '@memry/contracts/sync-api'
import type { SyncQueueManager } from '../queue'
import { compare, merge } from '@memry/sync-client/vector-clock'

export type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
export type EmitToWindows = (channel: string, data: unknown) => void
export type ApplyResult = 'applied' | 'skipped' | 'conflict' | 'parse_error'

export interface ApplyContext {
  db: DrizzleDb
  emit: EmitToWindows
  vaultKey?: Uint8Array
}

export interface SyncItemHandler<T = unknown> {
  readonly type: SyncItemType
  readonly schema: ZodType<T>
  applyUpsert(ctx: ApplyContext, itemId: string, data: T, clock: VectorClock): ApplyResult
  applyDelete(ctx: ApplyContext, itemId: string, clock?: VectorClock): 'applied' | 'skipped'
  fetchLocal(db: DrizzleDb, itemId: string): Record<string, unknown> | undefined
  seedUnclocked(db: DrizzleDb, deviceId: string, queue: SyncQueueManager): number
  buildPushPayload?(
    db: DrizzleDb,
    itemId: string,
    deviceId: string,
    operation: string,
    vaultKey?: Uint8Array
  ): string | null
  markPushSynced?(db: DrizzleDb, itemId: string): void
}

/**
 * A pulled item references an FK parent that does not exist locally. Thrown
 * instead of letting SQLite raise a bare `FOREIGN KEY constraint failed`, which
 * names neither the constraint nor the missing id — the pull coordinator needs
 * both to decide between "parent hasn't landed yet" and "parent is gone
 * everywhere, tombstone the child" (#837).
 */
export class MissingSyncParentError extends Error {
  constructor(
    readonly childType: string,
    readonly childId: string,
    readonly parentType: string,
    readonly parentId: string
  ) {
    super(`${childType} ${childId} references missing ${parentType} ${parentId}`)
    this.name = 'MissingSyncParentError'
  }
}

export interface ClockResolution {
  action: 'skip' | 'apply' | 'merge'
  mergedClock: VectorClock
}

export function resolveClockConflict(
  localClock: VectorClock | null | undefined,
  remoteClock: VectorClock
): ClockResolution {
  if (!localClock) return { action: 'apply', mergedClock: remoteClock }

  const cmp = compare(localClock, remoteClock)
  if (cmp === 'after') return { action: 'skip', mergedClock: localClock }
  if (cmp === 'concurrent') return { action: 'merge', mergedClock: merge(localClock, remoteClock) }
  return { action: 'apply', mergedClock: remoteClock }
}
