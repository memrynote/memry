import { eq, isNull } from 'drizzle-orm'
import { tagCategories } from '@memry/db-schema/schema/tag-categories'
import { utcNow } from '@memry/shared/utc'
import {
  TagCategorySyncPayloadSchema,
  type TagCategorySyncPayload
} from '@memry/contracts/sync-payloads'
import { TagsChannels } from '@memry/contracts/ipc-channels'
import type { VectorClock } from '@memry/contracts/sync-api'
import type { SyncQueueManager } from '../queue'
import { increment } from '../vector-clock'
import { createLogger } from '../../lib/logger'
import { BaseItemHandler } from './base-handler'
import type { ApplyContext, ApplyResult, DrizzleDb } from './types'

const log = createLogger('TagCategoryHandler')

class TagCategoryHandler extends BaseItemHandler<TagCategorySyncPayload> {
  readonly type = 'tag_category' as const
  readonly schema = TagCategorySyncPayloadSchema

  applyUpsert(
    ctx: ApplyContext,
    itemId: string,
    data: TagCategorySyncPayload,
    clock: VectorClock
  ): ApplyResult {
    return ctx.db.transaction((tx): ApplyResult => {
      const existing = tx.select().from(tagCategories).where(eq(tagCategories.id, itemId)).get()
      const remoteClock = Object.keys(clock).length > 0 ? clock : (data.clock ?? {})
      const now = utcNow()

      if (existing) {
        const resolution = this.resolveClock(existing.clock as VectorClock | null, remoteClock)
        if (resolution.action === 'skip') {
          log.info('Skipping remote tag category update, local is newer', { itemId })
          return 'skipped'
        }
        if (resolution.action === 'merge') {
          log.warn('Concurrent tag category edit, using last-write-wins', { itemId })
        }

        tx.update(tagCategories)
          .set({
            name: data.name,
            sortOrder: data.sortOrder,
            deletedAt: data.deletedAt ?? null,
            clock: resolution.mergedClock,
            updatedAt: data.updatedAt ?? now
          })
          .where(eq(tagCategories.id, itemId))
          .run()

        ctx.emit(TagsChannels.events.CATEGORIES_CHANGED, { categoryId: itemId })
        return resolution.action === 'merge' ? 'conflict' : 'applied'
      }

      tx.insert(tagCategories)
        .values({
          id: itemId,
          name: data.name,
          sortOrder: data.sortOrder,
          deletedAt: data.deletedAt ?? null,
          clock: remoteClock,
          createdAt: data.createdAt ?? now,
          updatedAt: data.updatedAt ?? now
        })
        .run()

      ctx.emit(TagsChannels.events.CATEGORIES_CHANGED, { categoryId: itemId })
      return 'applied'
    })
  }

  applyDelete(ctx: ApplyContext, itemId: string, clock?: VectorClock): 'applied' | 'skipped' {
    const existing = ctx.db.select().from(tagCategories).where(eq(tagCategories.id, itemId)).get()
    if (!existing) return 'skipped'

    if (clock && existing.clock) {
      const resolution = this.resolveClock(existing.clock as VectorClock | null, clock)
      if (resolution.action === 'skip' || resolution.action === 'merge') {
        log.info('Skipping remote tag category delete, local has unseen changes', { itemId })
        return 'skipped'
      }
    }

    // Soft delete: the row is the tombstone, and member tags must survive.
    ctx.db
      .update(tagCategories)
      .set({ deletedAt: utcNow(), updatedAt: utcNow() })
      .where(eq(tagCategories.id, itemId))
      .run()

    ctx.emit(TagsChannels.events.CATEGORIES_CHANGED, { categoryId: itemId })
    return 'applied'
  }

  fetchLocal(db: DrizzleDb, itemId: string): Record<string, unknown> | undefined {
    return db.select().from(tagCategories).where(eq(tagCategories.id, itemId)).get() as
      | Record<string, unknown>
      | undefined
  }

  buildPushPayload(
    db: DrizzleDb,
    itemId: string,
    _deviceId: string,
    _operation: string
  ): string | null {
    const row = db.select().from(tagCategories).where(eq(tagCategories.id, itemId)).get()
    if (!row) return null
    const payload: TagCategorySyncPayload = {
      name: row.name,
      sortOrder: row.sortOrder,
      deletedAt: row.deletedAt ?? null,
      clock: (row.clock as VectorClock) ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }
    return JSON.stringify(payload)
  }

  seedUnclocked(db: DrizzleDb, deviceId: string, queue: SyncQueueManager): number {
    const items = db.select().from(tagCategories).where(isNull(tagCategories.clock)).all()
    for (const item of items) {
      const clock = increment({}, deviceId)
      db.update(tagCategories).set({ clock }).where(eq(tagCategories.id, item.id)).run()
      queue.enqueue({
        type: 'tag_category',
        itemId: item.id,
        operation: 'create',
        payload: JSON.stringify({ ...item, clock }),
        priority: 0
      })
    }
    return items.length
  }
}

export const tagCategoryHandler = new TagCategoryHandler()
