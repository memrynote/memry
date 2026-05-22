import { eq, isNull } from 'drizzle-orm'
import { comments } from '@memry/db-schema/schema/comments'
import { CommentsChannels } from '@memry/contracts/ipc-channels'
import { CommentSyncPayloadSchema, type CommentSyncPayload } from '@memry/contracts/sync-payloads'
import type { VectorClock } from '@memry/contracts/sync-api'
import { utcNow } from '@memry/shared/utc'
import type { SyncQueueManager } from '../queue'
import { increment } from '../vector-clock'
import { createLogger } from '../../lib/logger'
import { BaseItemHandler } from './base-handler'
import type { ApplyContext, ApplyResult, DrizzleDb } from './types'

const log = createLogger('CommentHandler')

class CommentHandler extends BaseItemHandler<CommentSyncPayload> {
  readonly type = 'comment' as const
  readonly schema = CommentSyncPayloadSchema

  applyUpsert(
    ctx: ApplyContext,
    itemId: string,
    data: CommentSyncPayload,
    clock: VectorClock
  ): ApplyResult {
    return ctx.db.transaction((tx): ApplyResult => {
      const existing = tx.select().from(comments).where(eq(comments.id, itemId)).get()
      const remoteClock = Object.keys(clock).length > 0 ? clock : (data.clock ?? {})
      const now = utcNow()

      if (existing) {
        const resolution = this.resolveClock(existing.clock, remoteClock)
        if (resolution.action === 'skip') {
          log.info('Skipping remote comment update, local is newer', { itemId })
          return 'skipped'
        }

        tx.update(comments)
          .set({
            targetType: data.targetType ?? existing.targetType,
            targetId: data.targetId ?? existing.targetId,
            selectedQuote: data.selectedQuote ?? existing.selectedQuote,
            blockId: data.blockId ?? existing.blockId,
            rangeStart: data.rangeStart ?? existing.rangeStart,
            rangeEnd: data.rangeEnd ?? existing.rangeEnd,
            prefix: data.prefix ?? existing.prefix,
            suffix: data.suffix ?? existing.suffix,
            body: data.body ?? existing.body,
            attachmentRefs: data.attachmentRefs ?? existing.attachmentRefs ?? [],
            status: data.status ?? existing.status,
            clock: resolution.mergedClock,
            syncedAt: now,
            modifiedAt: data.modifiedAt ?? now
          })
          .where(eq(comments.id, itemId))
          .run()

        ctx.emit(CommentsChannels.events.CHANGED, {
          targetType: data.targetType ?? existing.targetType,
          targetId: data.targetId ?? existing.targetId,
          commentId: itemId,
          action: 'updated'
        })
        return resolution.action === 'merge' ? 'conflict' : 'applied'
      }

      if (!data.targetType || !data.targetId || !data.selectedQuote) {
        log.warn('Skipping remote comment create with missing target/quote', { itemId })
        return 'parse_error'
      }

      tx.insert(comments)
        .values({
          id: itemId,
          targetType: data.targetType,
          targetId: data.targetId,
          selectedQuote: data.selectedQuote,
          blockId: data.blockId ?? null,
          rangeStart: data.rangeStart ?? null,
          rangeEnd: data.rangeEnd ?? null,
          prefix: data.prefix ?? null,
          suffix: data.suffix ?? null,
          body: data.body ?? '',
          attachmentRefs: data.attachmentRefs ?? [],
          status: data.status ?? 'open',
          clock: remoteClock,
          syncedAt: now,
          createdAt: data.createdAt ?? now,
          modifiedAt: data.modifiedAt ?? now
        })
        .run()

      ctx.emit(CommentsChannels.events.CHANGED, {
        targetType: data.targetType,
        targetId: data.targetId,
        commentId: itemId,
        action: 'created'
      })
      return 'applied'
    })
  }

  applyDelete(ctx: ApplyContext, itemId: string, clock?: VectorClock): 'applied' | 'skipped' {
    const existing = ctx.db.select().from(comments).where(eq(comments.id, itemId)).get()
    if (!existing) return 'skipped'

    if (clock && existing.clock) {
      const resolution = this.resolveClock(existing.clock, clock)
      if (resolution.action === 'skip' || resolution.action === 'merge') {
        log.info('Skipping remote comment delete, local has unseen changes', { itemId })
        return 'skipped'
      }
    }

    ctx.db.delete(comments).where(eq(comments.id, itemId)).run()
    ctx.emit(CommentsChannels.events.CHANGED, {
      targetType: existing.targetType,
      targetId: existing.targetId,
      commentId: itemId,
      action: 'deleted'
    })
    return 'applied'
  }

  fetchLocal(db: DrizzleDb, itemId: string): Record<string, unknown> | undefined {
    return db.select().from(comments).where(eq(comments.id, itemId)).get() as
      | Record<string, unknown>
      | undefined
  }

  buildPushPayload(db: DrizzleDb, itemId: string): string | null {
    const row = db.select().from(comments).where(eq(comments.id, itemId)).get()
    if (!row) return null
    const payload: CommentSyncPayload = {
      targetType: row.targetType as 'note' | 'journal',
      targetId: row.targetId,
      selectedQuote: row.selectedQuote,
      blockId: row.blockId ?? null,
      rangeStart: row.rangeStart ?? null,
      rangeEnd: row.rangeEnd ?? null,
      prefix: row.prefix ?? null,
      suffix: row.suffix ?? null,
      body: row.body,
      attachmentRefs: row.attachmentRefs ?? [],
      status: row.status as 'open' | 'resolved' | 'archived',
      clock: row.clock ?? undefined,
      syncedAt: row.syncedAt ?? null,
      createdAt: row.createdAt,
      modifiedAt: row.modifiedAt
    }
    return JSON.stringify(payload)
  }

  markPushSynced(db: DrizzleDb, itemId: string): void {
    db.update(comments).set({ syncedAt: utcNow() }).where(eq(comments.id, itemId)).run()
  }

  seedUnclocked(db: DrizzleDb, deviceId: string, queue: SyncQueueManager): number {
    const items = db.select().from(comments).where(isNull(comments.clock)).all()
    for (const item of items) {
      const nextClock = increment({}, deviceId)
      db.update(comments).set({ clock: nextClock }).where(eq(comments.id, item.id)).run()
      queue.enqueue({
        type: 'comment',
        itemId: item.id,
        operation: 'create',
        payload: JSON.stringify({ ...item, clock: nextClock }),
        priority: 0
      })
    }
    return items.length
  }
}

export const commentHandler = new CommentHandler()
