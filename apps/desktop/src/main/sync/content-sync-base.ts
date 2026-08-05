import type { SyncItemType, VectorClock } from '@memry/contracts/sync-api'
import type { NoteMetadata } from '@memry/db-schema/data-schema'
import { RecordSyncController, incrementClock } from '@memry/sync-core'
import { getNoteMetadataById, updateNoteMetadata } from '@memry/storage-data'
import type Logger from 'electron-log'
import { getDatabase } from '../database/client'
import type { SyncQueueManager } from './queue'

export interface ContentSyncDeps {
  queue: SyncQueueManager
  getDeviceId: () => string | null
}

/**
 * Single reading of the "never leaves this device" flag, shared by the snapshot
 * path and the delete path so the two can never drift apart again.
 */
function isLocalOnly(local: NoteMetadata | undefined): boolean {
  return Boolean(local?.localOnly)
}

export abstract class ContentSyncService<
  TPayload extends Record<string, unknown>,
  TArgs extends string[] = []
> {
  protected queue: SyncQueueManager
  protected abstract readonly log: Logger.LogFunctions
  abstract readonly itemType: SyncItemType
  private readonly getDeviceId: () => string | null
  private controller: RecordSyncController<NoteMetadata, TArgs, TArgs> | null = null

  constructor(deps: ContentSyncDeps) {
    this.queue = deps.queue
    this.getDeviceId = deps.getDeviceId
  }

  protected abstract buildSnapshotPayload(
    cached: NoteMetadata,
    clock: VectorClock,
    operation: 'create' | 'update',
    ...extra: TArgs
  ): TPayload

  protected abstract buildDeletePayload(
    cached: NoteMetadata | undefined,
    clock: VectorClock,
    ...extra: TArgs
  ): TPayload | null

  enqueueCreate(itemId: string, ...extra: TArgs): void {
    this.getController().enqueueCreate(itemId, ...extra)
  }

  enqueueUpdate(itemId: string, ...extra: TArgs): void {
    this.getController().enqueueUpdate(itemId, ...extra)
  }

  enqueueDelete(itemId: string, ...extra: TArgs): void {
    this.getController().enqueueDelete(itemId, ...extra)
  }

  /**
   * Re-queue a push that was lost, WITHOUT advancing the clock — the item's
   * stored clock is the one that never made it to the server, so bumping it
   * again would only widen the gap. An item that is actually in step is
   * replay-detected server side and simply stamped as synced.
   */
  enqueueRecoveredUpdate(itemId: string): void {
    this.getController().enqueueRecoveredUpdate(itemId)
  }

  private getController(): RecordSyncController<NoteMetadata, TArgs, TArgs> {
    if (this.controller) return this.controller

    this.controller = new RecordSyncController({
      type: this.itemType,
      queue: this.queue,
      getDeviceId: this.getDeviceId,
      load: (itemId) => getNoteMetadataById(getDatabase(), itemId),
      handleMissingDevice: (itemId, operation) => {
        this.log.warn(`No device ID, skipping ${this.itemType} ${operation} enqueue`, { itemId })
      },
      applyLocalChange: ({ itemId, local, deviceId }) => {
        const nextClock = incrementClock((local.clock as VectorClock) ?? {}, deviceId)
        return (
          updateNoteMetadata(getDatabase(), itemId, { clock: nextClock }) ?? {
            ...local,
            clock: nextClock
          }
        )
      },
      serialize: (local, operation, extra) =>
        this.buildSnapshotPayload(local, (local.clock as VectorClock) ?? {}, operation, ...extra),
      shouldSkip: (local) => isLocalOnly(local),
      buildDeletePayload: ({ local, deviceId, extra }) => {
        // `localOnly` is the user's "this never leaves my device" switch, and
        // RecordSyncController wires `shouldSkip` into the create/update path
        // ONLY — its `enqueueDelete` never consults it. Without re-applying the
        // guard here, deleting a local-only row queues a tombstone that is
        // encrypted, uploaded to the server and fanned out to every other
        // device in the vault. Returning null makes the controller drop the
        // enqueue before it ever reaches the queue.
        //
        // This covers every subclass (notes and journals both load their row
        // via getNoteMetadataById, so both carry the same `localOnly` column).
        //
        // When `local` is undefined the row is already gone and we cannot tell
        // whether it was local-only, so the pre-existing behaviour stands and
        // the subclass decides (NoteSyncService returns null in that case).
        if (isLocalOnly(local)) return null

        const nextClock = incrementClock((local?.clock as VectorClock) ?? {}, deviceId)
        const payload = this.buildDeletePayload(local, nextClock, ...extra)
        return payload === null ? null : JSON.stringify(payload)
      }
    })

    return this.controller
  }
}
