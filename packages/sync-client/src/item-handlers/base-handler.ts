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

  protected resolveClock(
    localClock: VectorClock | null | undefined,
    remoteClock: VectorClock
  ): ClockResolution {
    return resolveClockConflict(localClock, remoteClock)
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
