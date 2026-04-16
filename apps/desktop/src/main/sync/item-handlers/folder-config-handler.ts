import { eq, isNull } from 'drizzle-orm'
import { folderConfigs } from '@memry/db-schema/schema/folder-configs'
import { utcNow } from '@memry/shared/utc'
import {
  FolderConfigSyncPayloadSchema,
  type FolderConfigSyncPayload
} from '@memry/contracts/sync-payloads'
import { NotesChannels } from '@memry/contracts/ipc-channels'
import type { VectorClock } from '@memry/contracts/sync-api'
import type { SyncQueueManager } from '../queue'
import { increment } from '../vector-clock'
import { createLogger } from '../../lib/logger'
import { BaseItemHandler } from './base-handler'
import type { ApplyContext, ApplyResult, DrizzleDb } from './types'
import { writeFolderConfig } from '../../vault/folders'

const log = createLogger('FolderConfigHandler')

class FolderConfigHandler extends BaseItemHandler<FolderConfigSyncPayload> {
  readonly type = 'folder_config' as const
  readonly schema = FolderConfigSyncPayloadSchema

  applyUpsert(
    ctx: ApplyContext,
    itemId: string,
    data: FolderConfigSyncPayload,
    clock: VectorClock
  ): ApplyResult {
    return ctx.db.transaction((tx): ApplyResult => {
      const existing = tx.select().from(folderConfigs).where(eq(folderConfigs.path, itemId)).get()
      const remoteClock = Object.keys(clock).length > 0 ? clock : (data.clock ?? {})
      const now = utcNow()

      if (existing) {
        const resolution = this.resolveClock(existing.clock as VectorClock | null, remoteClock)
        if (resolution.action === 'skip') {
          log.info('Skipping remote folder config update, local is newer', { itemId })
          return 'skipped'
        }
        if (resolution.action === 'merge') {
          log.warn('Concurrent folder config edit, using last-write-wins', { itemId })
        }

        tx.update(folderConfigs)
          .set({
            icon: data.icon ?? existing.icon,
            clock: resolution.mergedClock,
            modifiedAt: data.modifiedAt ?? now
          })
          .where(eq(folderConfigs.path, itemId))
          .run()

        writeFolderConfig(itemId, { icon: data.icon ?? existing.icon })
        ctx.emit(NotesChannels.events.FOLDER_CONFIG_UPDATED, { path: itemId })
        return resolution.action === 'merge' ? 'conflict' : 'applied'
      }

      tx.insert(folderConfigs)
        .values({
          path: itemId,
          icon: data.icon ?? null,
          clock: remoteClock,
          createdAt: data.createdAt ?? now,
          modifiedAt: data.modifiedAt ?? now
        })
        .run()

      writeFolderConfig(itemId, { icon: data.icon ?? null })
      ctx.emit(NotesChannels.events.FOLDER_CONFIG_UPDATED, { path: itemId })
      return 'applied'
    })
  }

  applyDelete(ctx: ApplyContext, itemId: string, clock?: VectorClock): 'applied' | 'skipped' {
    const existing = ctx.db.select().from(folderConfigs).where(eq(folderConfigs.path, itemId)).get()
    if (!existing) return 'skipped'

    if (clock && existing.clock) {
      const resolution = this.resolveClock(existing.clock as VectorClock | null, clock)
      if (resolution.action === 'skip' || resolution.action === 'merge') {
        log.info('Skipping remote folder config delete, local has unseen changes', { itemId })
        return 'skipped'
      }
    }

    ctx.db.delete(folderConfigs).where(eq(folderConfigs.path, itemId)).run()
    writeFolderConfig(itemId, { icon: null })
    ctx.emit(NotesChannels.events.FOLDER_CONFIG_UPDATED, { path: itemId })
    return 'applied'
  }

  fetchLocal(db: DrizzleDb, itemId: string): Record<string, unknown> | undefined {
    return db.select().from(folderConfigs).where(eq(folderConfigs.path, itemId)).get() as
      | Record<string, unknown>
      | undefined
  }

  buildPushPayload(
    db: DrizzleDb,
    itemId: string,
    _deviceId: string,
    _operation: string
  ): string | null {
    const row = db.select().from(folderConfigs).where(eq(folderConfigs.path, itemId)).get()
    if (!row) return null
    const payload: FolderConfigSyncPayload = {
      icon: row.icon ?? null,
      clock: (row.clock as VectorClock) ?? undefined,
      createdAt: row.createdAt,
      modifiedAt: row.modifiedAt
    }
    return JSON.stringify(payload)
  }

  seedUnclocked(db: DrizzleDb, deviceId: string, queue: SyncQueueManager): number {
    const items = db.select().from(folderConfigs).where(isNull(folderConfigs.clock)).all()
    for (const item of items) {
      const clock = increment({}, deviceId)
      db.update(folderConfigs).set({ clock }).where(eq(folderConfigs.path, item.path)).run()
      queue.enqueue({
        type: 'folder_config',
        itemId: item.path,
        operation: 'create',
        payload: JSON.stringify({ ...item, clock }),
        priority: 0
      })
    }
    return items.length
  }
}

export const folderConfigHandler = new FolderConfigHandler()
