import type { ZodType } from 'zod'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as dataSchema from '@shared/db/schema/data-schema'
import type { VectorClock, SyncItemType } from '@shared/contracts/sync-api'
import type { SyncQueueManager } from '../queue'
import { compare, merge } from '../vector-clock'

export type DrizzleDb = BetterSQLite3Database<typeof dataSchema>
export type EmitToWindows = (channel: string, data: unknown) => void
export type ApplyResult = 'applied' | 'skipped' | 'conflict'

export interface ApplyContext {
  db: DrizzleDb
  emit: EmitToWindows
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
    operation: string
  ): string | null
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
