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

  abstract applyUpsert(
    ctx: ApplyContext,
    itemId: string,
    data: T,
    clock: VectorClock
  ): ApplyResult

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
}
