import { eq, isNull } from 'drizzle-orm'
import { bookmarks } from '@memry/db-schema/schema/bookmarks'
import { BookmarkSyncPayloadSchema, type BookmarkSyncPayload } from '@memry/contracts/sync-payloads'
import { BookmarksChannels } from '@memry/contracts/ipc-channels'
import type { VectorClock } from '@memry/contracts/sync-api'
import { utcNow } from '@memry/shared/utc'
import type { SyncQueueManager } from '../queue'
import { increment } from '../vector-clock'
import { createLogger } from '../../lib/logger'
import { BaseItemHandler } from './base-handler'
import type { ApplyContext, ApplyResult, DrizzleDb } from './types'

const log = createLogger('BookmarkHandler')

class BookmarkHandler extends BaseItemHandler<BookmarkSyncPayload> {
  readonly type = 'bookmark' as const
  readonly schema = BookmarkSyncPayloadSchema

  applyUpsert(
    ctx: ApplyContext,
    itemId: string,
    data: BookmarkSyncPayload,
    clock: VectorClock
  ): ApplyResult {
    return ctx.db.transaction((tx): ApplyResult => {
      const existing = tx.select().from(bookmarks).where(eq(bookmarks.id, itemId)).get()
      const remoteClock = Object.keys(clock).length > 0 ? clock : (data.clock ?? {})
      const now = utcNow()

      if (existing) {
        const resolution = this.resolveClock(existing.clock, remoteClock)
        if (resolution.action === 'skip') {
          log.info('Skipping remote bookmark update, local is newer', { itemId })
          return 'skipped'
        }
        if (resolution.action === 'merge') {
          log.warn('Concurrent bookmark edit, using last-write-wins', { itemId })
        }

        tx.update(bookmarks)
          .set({
            itemType: data.itemType ?? existing.itemType,
            itemId: data.itemId ?? existing.itemId,
            position: data.position ?? existing.position,
            clock: resolution.mergedClock,
            syncedAt: now
          })
          .where(eq(bookmarks.id, itemId))
          .run()

        ctx.emit(BookmarksChannels.events.UPDATED, { id: itemId })
        return resolution.action === 'merge' ? 'conflict' : 'applied'
      }

      if (!data.itemType || !data.itemId) {
        log.warn('Skipping bookmark insert, payload missing itemType or itemId', { itemId })
        return 'skipped'
      }

      tx.insert(bookmarks)
        .values({
          id: itemId,
          itemType: data.itemType,
          itemId: data.itemId,
          position: data.position ?? 0,
          clock: remoteClock,
          syncedAt: now,
          createdAt: data.createdAt ?? now
        })
        .run()

      ctx.emit(BookmarksChannels.events.CREATED, { id: itemId })
      return 'applied'
    })
  }

  applyDelete(ctx: ApplyContext, itemId: string, clock?: VectorClock): 'applied' | 'skipped' {
    const existing = ctx.db.select().from(bookmarks).where(eq(bookmarks.id, itemId)).get()
    if (!existing) return 'skipped'

    if (clock && existing.clock) {
      const resolution = this.resolveClock(existing.clock, clock)
      if (resolution.action === 'skip' || resolution.action === 'merge') {
        log.info('Skipping remote bookmark delete, local has unseen changes', { itemId })
        return 'skipped'
      }
    }

    ctx.db.delete(bookmarks).where(eq(bookmarks.id, itemId)).run()
    ctx.emit(BookmarksChannels.events.DELETED, { id: itemId })
    return 'applied'
  }

  fetchLocal(db: DrizzleDb, itemId: string): Record<string, unknown> | undefined {
    return db.select().from(bookmarks).where(eq(bookmarks.id, itemId)).get() as
      | Record<string, unknown>
      | undefined
  }

  buildPushPayload(
    db: DrizzleDb,
    itemId: string,
    _deviceId: string,
    _operation: string
  ): string | null {
    const bookmark = db.select().from(bookmarks).where(eq(bookmarks.id, itemId)).get()
    if (!bookmark) return null
    return JSON.stringify(bookmark)
  }

  markPushSynced(db: DrizzleDb, itemId: string): void {
    db.update(bookmarks).set({ syncedAt: utcNow() }).where(eq(bookmarks.id, itemId)).run()
  }

  seedUnclocked(db: DrizzleDb, deviceId: string, queue: SyncQueueManager): number {
    const items = db.select().from(bookmarks).where(isNull(bookmarks.clock)).all()
    for (const item of items) {
      const clock = increment({}, deviceId)
      db.update(bookmarks).set({ clock }).where(eq(bookmarks.id, item.id)).run()
      queue.enqueue({
        type: 'bookmark',
        itemId: item.id,
        operation: 'create',
        payload: JSON.stringify({ ...item, clock }),
        priority: 0
      })
    }
    return items.length
  }
}

export const bookmarkHandler = new BookmarkHandler()
