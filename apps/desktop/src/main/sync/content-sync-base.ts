import type { SyncItemType, VectorClock } from '@memry/contracts/sync-api'
import { RecordSyncController, incrementClock } from '@memry/sync-core'
import type { NoteCache } from '@memry/db-schema/schema/notes-cache'
import type { SyncQueueManager } from './queue'
import { getIndexDatabase } from '../database/client'
import { getNoteCacheById, updateNoteCache } from '@main/database/queries/notes'
import type Logger from 'electron-log'

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
  private controller: RecordSyncController<NoteCache, TArgs, TArgs> | null = null

  constructor(deps: ContentSyncDeps) {
    this.queue = deps.queue
    this.getDeviceId = deps.getDeviceId
  }

  protected abstract buildSnapshotPayload(
    cached: NoteCache,
    clock: VectorClock,
    operation: 'create' | 'update',
    ...extra: TArgs
  ): TPayload

  protected abstract buildDeletePayload(
    cached: NoteCache | undefined,
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

  private getController(): RecordSyncController<NoteCache, TArgs, TArgs> {
    if (this.controller) return this.controller

    this.controller = new RecordSyncController({
      type: this.itemType,
      queue: this.queue,
      getDeviceId: this.getDeviceId,
      load: (itemId) => getNoteCacheById(getIndexDatabase(), itemId),
      applyLocalChange: ({ itemId, local, deviceId }) => {
        const nextClock = incrementClock((local.clock as VectorClock) ?? {}, deviceId)
        updateNoteCache(getIndexDatabase(), itemId, { clock: nextClock })
        return { ...local, clock: nextClock }
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
