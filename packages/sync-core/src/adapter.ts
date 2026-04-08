import type { ZodType } from 'zod'
import type { SyncItemType, SyncOperation, VectorClock } from '@memry/contracts/sync-api'
import type { CrdtSyncAdapter } from './crdt-sync'

export type SyncAdapterKind = 'record' | 'crdt'
export type RemoteApplyResult = 'applied' | 'skipped' | 'conflict' | 'parse_error'

export interface QueueLike {
  enqueue(input: {
    type: SyncItemType
    itemId: string
    operation: SyncOperation
    payload: string
    priority?: number
  }): string
}

export interface RecordLocalSyncAdapter {
  enqueueCreate(itemId: string, ...extra: unknown[]): void
  enqueueUpdate(itemId: string, ...extra: unknown[]): void
  enqueueDelete(itemId: string, ...extra: unknown[]): void
  enqueueForPush?(itemId: string, operation: 'create' | 'update', ...extra: unknown[]): void
  enqueueRecoveredUpdate?(itemId: string): void
}

export interface RemoteSyncAdapter<TDb = unknown, TEmit = unknown, TPayload = unknown> {
  readonly type: SyncItemType
  readonly schema: ZodType<TPayload>
  applyRemoteMutation(input: {
    db: TDb
    emit: TEmit
    itemId: string
    operation: SyncOperation
    data?: TPayload
    clock?: VectorClock
  }): RemoteApplyResult
  fetchLocal?(db: TDb, itemId: string): Record<string, unknown> | undefined
  seedUnclocked?(db: TDb, deviceId: string, queue: QueueLike): number
  buildPushPayload?(db: TDb, itemId: string, deviceId: string, operation: string): string | null
  markPushSynced?(db: TDb, itemId: string): void
}

export interface SyncAdapter<TDb = unknown, TEmit = unknown, TPayload = unknown> {
  readonly type: SyncItemType
  readonly kind: SyncAdapterKind
  readonly local?: RecordLocalSyncAdapter
  readonly remote?: RemoteSyncAdapter<TDb, TEmit, TPayload>
  readonly crdt?: CrdtSyncAdapter
}
