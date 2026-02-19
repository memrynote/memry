import { eq, isNull } from 'drizzle-orm'
import { tagDefinitions } from '@shared/db/schema/tag-definitions'
import {
  TagDefinitionSyncPayloadSchema,
  type TagDefinitionSyncPayload
} from '@shared/contracts/sync-payloads'
import { TagsChannels } from '@shared/ipc-channels'
import type { VectorClock } from '@shared/contracts/sync-api'
import type { SyncQueueManager } from '../queue'
import { increment } from '../vector-clock'
import { createLogger } from '../../lib/logger'
import { resolveClockConflict } from './types'
import type { SyncItemHandler, ApplyContext, ApplyResult, DrizzleDb } from './types'

const log = createLogger('TagDefinitionHandler')

export const tagDefinitionHandler: SyncItemHandler<TagDefinitionSyncPayload> = {
  type: 'tag_definition',
  schema: TagDefinitionSyncPayloadSchema,

  applyUpsert(
    ctx: ApplyContext,
    itemId: string,
    data: TagDefinitionSyncPayload,
    clock: VectorClock
  ): ApplyResult {
    return ctx.db.transaction((tx): ApplyResult => {
      const existing = tx
        .select()
        .from(tagDefinitions)
        .where(eq(tagDefinitions.name, itemId))
        .get()
      const remoteClock = Object.keys(clock).length > 0 ? clock : (data.clock ?? {})
      const now = new Date().toISOString()

      if (existing) {
        const resolution = resolveClockConflict(
          existing.clock as VectorClock | null,
          remoteClock
        )
        if (resolution.action === 'skip') {
          log.info('Skipping remote tag definition update, local is newer', { itemId })
          return 'skipped'
        }
        if (resolution.action === 'merge') {
          log.warn('Concurrent tag definition edit, using last-write-wins', { itemId })
        }

        tx.update(tagDefinitions)
          .set({
            color: data.color ?? existing.color,
            clock: resolution.mergedClock
          })
          .where(eq(tagDefinitions.name, itemId))
          .run()

        ctx.emit(TagsChannels.events.COLOR_UPDATED, { tag: itemId, color: data.color })
        return resolution.action === 'merge' ? 'conflict' : 'applied'
      }

      tx.insert(tagDefinitions)
        .values({
          name: itemId,
          color: data.color ?? '#808080',
          clock: remoteClock,
          createdAt: data.createdAt ?? now
        })
        .run()

      ctx.emit(TagsChannels.events.NOTES_CHANGED, { tag: itemId })
      return 'applied'
    })
  },

  applyDelete(ctx: ApplyContext, itemId: string, clock?: VectorClock): 'applied' | 'skipped' {
    const existing = ctx.db
      .select()
      .from(tagDefinitions)
      .where(eq(tagDefinitions.name, itemId))
      .get()
    if (!existing) return 'skipped'

    if (clock && existing.clock) {
      const resolution = resolveClockConflict(existing.clock as VectorClock | null, clock)
      if (resolution.action === 'skip' || resolution.action === 'merge') {
        log.info('Skipping remote tag definition delete, local has unseen changes', { itemId })
        return 'skipped'
      }
    }

    ctx.db.delete(tagDefinitions).where(eq(tagDefinitions.name, itemId)).run()
    ctx.emit(TagsChannels.events.DELETED, { tag: itemId })
    return 'applied'
  },

  fetchLocal(db: DrizzleDb, itemId: string): Record<string, unknown> | undefined {
    return db.select().from(tagDefinitions).where(eq(tagDefinitions.name, itemId)).get() as
      | Record<string, unknown>
      | undefined
  },

  buildPushPayload(
    db: DrizzleDb,
    itemId: string,
    _deviceId: string,
    _operation: string
  ): string | null {
    const tag = db.select().from(tagDefinitions).where(eq(tagDefinitions.name, itemId)).get()
    if (!tag) return null
    const payload: TagDefinitionSyncPayload = {
      name: tag.name,
      color: tag.color,
      clock: (tag.clock as VectorClock) ?? undefined,
      createdAt: tag.createdAt
    }
    return JSON.stringify(payload)
  },

  seedUnclocked(db: DrizzleDb, deviceId: string, queue: SyncQueueManager): number {
    const items = db.select().from(tagDefinitions).where(isNull(tagDefinitions.clock)).all()
    for (const item of items) {
      const clock = increment({}, deviceId)
      db.update(tagDefinitions).set({ clock }).where(eq(tagDefinitions.name, item.name)).run()
      queue.enqueue({
        type: 'tag_definition',
        itemId: item.name,
        operation: 'create',
        payload: JSON.stringify({ ...item, clock }),
        priority: 0
      })
    }
    return items.length
  }
}
