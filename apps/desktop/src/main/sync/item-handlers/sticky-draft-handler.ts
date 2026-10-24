import { eq, isNull } from 'drizzle-orm'
import { stickyDrafts } from '@memry/db-schema/schema/sticky-drafts'
import {
  StickyDraftSyncPayloadSchema,
  type StickyDraftSyncPayload
} from '@memry/contracts/sync-payloads'
import { StickyChannels } from '@memry/contracts/ipc-channels'
import type { VectorClock } from '@memry/contracts/sync-api'
import { utcNow } from '@memry/shared/utc'
import type { SyncQueueManager } from '@memry/sync-client/queue'
import { increment } from '@memry/sync-client/vector-clock'
import { createLogger } from '../../lib/logger'
import { notifyStickyDraftsChanged } from '../../stickies/drafts-changed'
import { BaseItemHandler } from '@memry/sync-client/item-handlers/base-handler'
import type { ApplyContext, ApplyResult, DrizzleDb } from '@memry/sync-client/item-handlers/types'

const log = createLogger('StickyDraftHandler')

class StickyDraftHandler extends BaseItemHandler<StickyDraftSyncPayload> {
  readonly type = 'sticky_draft' as const
  readonly schema = StickyDraftSyncPayloadSchema

  applyUpsert(
    ctx: ApplyContext,
    itemId: string,
    data: StickyDraftSyncPayload,
    clock: VectorClock
  ): ApplyResult {
    const result = ctx.db.transaction((tx): ApplyResult => {
      const existing = tx.select().from(stickyDrafts).where(eq(stickyDrafts.id, itemId)).get()
      const remoteClock = Object.keys(clock).length > 0 ? clock : (data.clock ?? {})
      const now = utcNow()

      if (existing) {
        const resolution = this.resolveUpsertClock(ctx, itemId, existing.clock, remoteClock, data)
        if (resolution.action === 'skip') return 'skipped'
        if (resolution.action === 'merge') {
          log.info('Concurrent sticky draft edit, using last-write-wins', { itemId })
        }

        tx.update(stickyDrafts)
          .set({
            content: data.content ?? existing.content,
            kind: data.kind ?? existing.kind,
            clock: resolution.mergedClock,
            syncedAt: now,
            modifiedAt: data.modifiedAt ?? now
          })
          .where(eq(stickyDrafts.id, itemId))
          .run()
        return resolution.action === 'merge' ? 'conflict' : 'applied'
      }

      // Every payload field is optional, so `{}` parses. A frozen-payload push
      // must not materialise an empty draft whose empty clock loses every
      // later version.
      if (data.content === undefined) {
        log.warn('Skipping remote sticky draft insert, payload has no content', { itemId })
        return 'skipped'
      }

      tx.insert(stickyDrafts)
        .values({
          id: itemId,
          content: data.content,
          kind: data.kind ?? 'note',
          clock: remoteClock,
          syncedAt: now,
          createdAt: data.createdAt ?? now,
          modifiedAt: data.modifiedAt ?? now
        })
        .run()
      return 'applied'
    })

    if (result !== 'skipped') this.announce(ctx)
    return result
  }

  applyDelete(ctx: ApplyContext, itemId: string, clock?: VectorClock): 'applied' | 'skipped' {
    const existing = ctx.db.select().from(stickyDrafts).where(eq(stickyDrafts.id, itemId)).get()
    if (!existing) return 'skipped'

    if (clock && existing.clock && this.resolveDeleteClock(existing.clock, clock).skip) {
      log.info('Skipping remote sticky draft delete, local is ahead of the tombstone', { itemId })
      return 'skipped'
    }

    ctx.db.delete(stickyDrafts).where(eq(stickyDrafts.id, itemId)).run()
    this.announce(ctx)
    return 'applied'
  }

  /** Windows re-read the list; main re-checks whether the edge tab should show. */
  private announce(ctx: ApplyContext): void {
    ctx.emit(StickyChannels.events.DRAFTS_CHANGED, {})
    notifyStickyDraftsChanged()
  }

  fetchLocal(db: DrizzleDb, itemId: string): Record<string, unknown> | undefined {
    return db.select().from(stickyDrafts).where(eq(stickyDrafts.id, itemId)).get()
  }

  buildPushPayload(
    db: DrizzleDb,
    itemId: string,
    _deviceId: string,
    _operation: string
  ): string | null {
    const draft = db.select().from(stickyDrafts).where(eq(stickyDrafts.id, itemId)).get()
    if (!draft) return null
    return JSON.stringify(draft)
  }

  markPushSynced(db: DrizzleDb, itemId: string): void {
    db.update(stickyDrafts).set({ syncedAt: utcNow() }).where(eq(stickyDrafts.id, itemId)).run()
  }

  seedUnclocked(db: DrizzleDb, deviceId: string, queue: SyncQueueManager): number {
    const items = db.select().from(stickyDrafts).where(isNull(stickyDrafts.clock)).all()
    for (const item of items) {
      const clock = increment({}, deviceId)
      db.update(stickyDrafts).set({ clock }).where(eq(stickyDrafts.id, item.id)).run()
      queue.enqueue({
        type: 'sticky_draft',
        itemId: item.id,
        operation: 'create',
        payload: JSON.stringify({ ...item, clock }),
        priority: 0
      })
    }
    return items.length
  }
}

export const stickyDraftHandler = new StickyDraftHandler()
