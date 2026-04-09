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
      shouldSkip: (local) => Boolean(local.localOnly),
      buildDeletePayload: ({ local, deviceId, extra }) => {
        const nextClock = incrementClock((local?.clock as VectorClock) ?? {}, deviceId)
        const payload = this.buildDeletePayload(local, nextClock, ...extra)
        return payload === null ? null : JSON.stringify(payload)
      }
    })

    return this.controller
  }
}
