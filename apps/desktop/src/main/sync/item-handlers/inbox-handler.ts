import { eq, isNull, and, not } from 'drizzle-orm'
import { inboxItems } from '@memry/db-schema/schema/inbox'
import { InboxSyncPayloadSchema, type InboxSyncPayload } from '@memry/contracts/sync-payloads'
import { InboxChannels } from '@memry/contracts/ipc-channels'
import type { VectorClock } from '@memry/contracts/sync-api'
import { utcNow } from '@memry/shared/utc'
import type { SyncQueueManager } from '../queue'
import { increment } from '../vector-clock'
import { createLogger } from '../../lib/logger'
import { resolveClockConflict } from './types'
import type { SyncItemHandler, ApplyContext, ApplyResult, DrizzleDb } from './types'
import { publishProjectionEvent } from '../../projections'

const log = createLogger('InboxHandler')

export const inboxHandler: SyncItemHandler<InboxSyncPayload> = {
  type: 'inbox',
  schema: InboxSyncPayloadSchema,

  applyUpsert(
    ctx: ApplyContext,
    itemId: string,
    data: InboxSyncPayload,
    clock: VectorClock
  ): ApplyResult {
    return ctx.db.transaction((tx): ApplyResult => {
      const existing = tx.select().from(inboxItems).where(eq(inboxItems.id, itemId)).get()
      const remoteClock = Object.keys(clock).length > 0 ? clock : (data.clock ?? {})
      const now = utcNow()

      if (existing) {
        const resolution = resolveClockConflict(existing.clock, remoteClock)
        if (resolution.action === 'skip') {
          log.info('Skipping remote inbox update, local is newer', { itemId })
          return 'skipped'
        }
        if (resolution.action === 'merge') {
          log.warn('Concurrent inbox edit, using last-write-wins', { itemId })
        }

        tx.update(inboxItems)
          .set({
            title: data.title ?? existing.title,
            content: data.content ?? null,
            type: data.type ?? existing.type,
            metadata: data.metadata ?? null,
            filedAt: data.filedAt ?? null,
            filedTo: data.filedTo ?? null,
            filedAction: data.filedAction ?? null,
            snoozedUntil: data.snoozedUntil ?? null,
            snoozeReason: data.snoozeReason ?? null,
            archivedAt: data.archivedAt ?? null,
            sourceUrl: data.sourceUrl ?? null,
            sourceTitle: data.sourceTitle ?? null,
            captureSource: data.captureSource ?? existing.captureSource ?? null,
            clock: resolution.mergedClock,
            syncedAt: now,
            modifiedAt: data.modifiedAt ?? now
          })
          .where(eq(inboxItems.id, itemId))
          .run()

        ctx.emit(InboxChannels.events.UPDATED, { id: itemId })
        publishProjectionEvent({ type: 'inbox.upserted', itemId })
        return resolution.action === 'merge' ? 'conflict' : 'applied'
      }

      tx.insert(inboxItems)
        .values({
          id: itemId,
          title: data.title ?? 'Untitled',
          type: data.type ?? 'note',
          content: data.content ?? null,
          metadata: data.metadata ?? null,
          sourceUrl: data.sourceUrl ?? null,
          sourceTitle: data.sourceTitle ?? null,
          captureSource: data.captureSource ?? null,
          clock: remoteClock,
          syncedAt: now,
          createdAt: data.createdAt ?? now,
          modifiedAt: data.modifiedAt ?? now
        })
        .run()

      ctx.emit(InboxChannels.events.CAPTURED, { id: itemId })
      publishProjectionEvent({ type: 'inbox.upserted', itemId })
      return 'applied'
    })
  },

  applyDelete(ctx: ApplyContext, itemId: string, clock?: VectorClock): 'applied' | 'skipped' {
    const existing = ctx.db.select().from(inboxItems).where(eq(inboxItems.id, itemId)).get()
    if (!existing) return 'skipped'

    if (clock && existing.clock) {
      const resolution = resolveClockConflict(existing.clock, clock)
      if (resolution.action === 'skip' || resolution.action === 'merge') {
        log.info('Skipping remote inbox delete, local has unseen changes', { itemId })
        return 'skipped'
      }
    }

    ctx.db.delete(inboxItems).where(eq(inboxItems.id, itemId)).run()
    ctx.emit(InboxChannels.events.ARCHIVED, { id: itemId })
    publishProjectionEvent({ type: 'inbox.deleted', itemId })
    return 'applied'
  },

  fetchLocal(db: DrizzleDb, itemId: string): Record<string, unknown> | undefined {
    return db.select().from(inboxItems).where(eq(inboxItems.id, itemId)).get() as
      | Record<string, unknown>
      | undefined
  },

  buildPushPayload(
    db: DrizzleDb,
    itemId: string,
    _deviceId: string,
    _operation: string
  ): string | null {
    const item = db.select().from(inboxItems).where(eq(inboxItems.id, itemId)).get()
    if (!item || item.localOnly) return null
    return JSON.stringify(item)
  },

  markPushSynced(db: DrizzleDb, itemId: string): void {
    db.update(inboxItems).set({ syncedAt: utcNow() }).where(eq(inboxItems.id, itemId)).run()
  },

  seedUnclocked(db: DrizzleDb, deviceId: string, queue: SyncQueueManager): number {
    const items = db
      .select()
      .from(inboxItems)
      .where(and(isNull(inboxItems.clock), not(eq(inboxItems.localOnly, true))))
      .all()
    for (const item of items) {
      const clock = increment({}, deviceId)
      db.update(inboxItems).set({ clock }).where(eq(inboxItems.id, item.id)).run()
      queue.enqueue({
        type: 'inbox',
        itemId: item.id,
        operation: 'create',
        payload: JSON.stringify({ ...item, clock }),
        priority: 0
      })
    }
    return items.length
  }
}
