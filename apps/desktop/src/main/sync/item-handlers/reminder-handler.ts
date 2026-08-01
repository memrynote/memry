import { eq, isNull } from 'drizzle-orm'
import { reminders } from '@memry/db-schema/schema/reminders'
import { ReminderSyncPayloadSchema, type ReminderSyncPayload } from '@memry/contracts/sync-payloads'
import { ReminderChannels } from '@memry/contracts/ipc-channels'
import type { VectorClock } from '@memry/contracts/sync-api'
import { utcNow } from '@memry/shared/utc'
import type { SyncQueueManager } from '../queue'
import { increment } from '../vector-clock'
import { createLogger } from '../../lib/logger'
import { BaseItemHandler } from './base-handler'
import type { ApplyContext, ApplyResult, DrizzleDb } from './types'

const log = createLogger('ReminderHandler')

/**
 * `triggeredAt` is intentionally never read from or written by the payload.
 * It records that THIS device showed an OS notification. Syncing it would make
 * a device that never displayed the reminder believe it already had, silently
 * swallowing the notification.
 */
class ReminderHandler extends BaseItemHandler<ReminderSyncPayload> {
  readonly type = 'reminder' as const
  readonly schema = ReminderSyncPayloadSchema

  applyUpsert(
    ctx: ApplyContext,
    itemId: string,
    data: ReminderSyncPayload,
    clock: VectorClock
  ): ApplyResult {
    return ctx.db.transaction((tx): ApplyResult => {
      const existing = tx.select().from(reminders).where(eq(reminders.id, itemId)).get()
      const remoteClock = Object.keys(clock).length > 0 ? clock : (data.clock ?? {})
      const now = utcNow()

      if (existing) {
        const resolution = this.resolveClock(existing.clock, remoteClock)
        if (resolution.action === 'skip') {
          log.info('Skipping remote reminder update, local is newer', { itemId })
          return 'skipped'
        }
        if (resolution.action === 'merge') {
          log.warn('Concurrent reminder edit, using last-write-wins', { itemId })
        }

        // triggeredAt is deliberately absent from this set — device-local.
        tx.update(reminders)
          .set({
            targetType: data.targetType ?? existing.targetType,
            targetId: data.targetId ?? existing.targetId,
            remindAt: data.remindAt ?? existing.remindAt,
            anchorId: data.anchorId ?? existing.anchorId,
            highlightText: data.highlightText ?? existing.highlightText,
            highlightStart: data.highlightStart ?? existing.highlightStart,
            highlightEnd: data.highlightEnd ?? existing.highlightEnd,
            title: data.title ?? existing.title,
            note: data.note ?? existing.note,
            status: data.status ?? existing.status,
            dismissedAt: data.dismissedAt ?? existing.dismissedAt,
            snoozedUntil: data.snoozedUntil ?? existing.snoozedUntil,
            modifiedAt: data.modifiedAt ?? now,
            clock: resolution.mergedClock,
            syncedAt: now
          })
          .where(eq(reminders.id, itemId))
          .run()

        ctx.emit(ReminderChannels.events.UPDATED, { id: itemId })
        return resolution.action === 'merge' ? 'conflict' : 'applied'
      }

      if (!data.targetType || !data.targetId) {
        log.warn('Skipping reminder insert, payload missing targetType or targetId', { itemId })
        return 'skipped'
      }

      tx.insert(reminders)
        .values({
          id: itemId,
          targetType: data.targetType,
          targetId: data.targetId,
          remindAt: data.remindAt ?? now,
          anchorId: data.anchorId ?? null,
          highlightText: data.highlightText ?? null,
          highlightStart: data.highlightStart ?? null,
          highlightEnd: data.highlightEnd ?? null,
          title: data.title ?? null,
          note: data.note ?? null,
          status: data.status ?? 'pending',
          dismissedAt: data.dismissedAt ?? null,
          snoozedUntil: data.snoozedUntil ?? null,
          clock: remoteClock,
          syncedAt: now,
          createdAt: data.createdAt ?? now,
          modifiedAt: data.modifiedAt ?? now
        })
        .run()

      ctx.emit(ReminderChannels.events.CREATED, { id: itemId })
      return 'applied'
    })
  }

  applyDelete(ctx: ApplyContext, itemId: string, clock?: VectorClock): 'applied' | 'skipped' {
    const existing = ctx.db.select().from(reminders).where(eq(reminders.id, itemId)).get()
    if (!existing) return 'skipped'

    if (clock && existing.clock) {
      const resolution = this.resolveClock(existing.clock, clock)
      if (resolution.action === 'skip' || resolution.action === 'merge') {
        log.info('Skipping remote reminder delete, local has unseen changes', { itemId })
        return 'skipped'
      }
    }

    ctx.db.delete(reminders).where(eq(reminders.id, itemId)).run()
    ctx.emit(ReminderChannels.events.DELETED, { id: itemId })
    return 'applied'
  }

  fetchLocal(db: DrizzleDb, itemId: string): Record<string, unknown> | undefined {
    return db.select().from(reminders).where(eq(reminders.id, itemId)).get() as
      | Record<string, unknown>
      | undefined
  }

  buildPushPayload(
    db: DrizzleDb,
    itemId: string,
    _deviceId: string,
    _operation: string
  ): string | null {
    const reminder = db.select().from(reminders).where(eq(reminders.id, itemId)).get()
    if (!reminder) return null
    const { triggeredAt: _triggeredAt, ...syncable } = reminder
    return JSON.stringify(syncable)
  }

  markPushSynced(db: DrizzleDb, itemId: string): void {
    db.update(reminders).set({ syncedAt: utcNow() }).where(eq(reminders.id, itemId)).run()
  }

  seedUnclocked(db: DrizzleDb, deviceId: string, queue: SyncQueueManager): number {
    const items = db.select().from(reminders).where(isNull(reminders.clock)).all()
    for (const item of items) {
      const clock = increment({}, deviceId)
      db.update(reminders).set({ clock }).where(eq(reminders.id, item.id)).run()
      const { triggeredAt: _triggeredAt, ...syncable } = item
      queue.enqueue({
        type: 'reminder',
        itemId: item.id,
        operation: 'create',
        payload: JSON.stringify({ ...syncable, clock }),
        priority: 0
      })
    }
    return items.length
  }
}

export const reminderHandler = new ReminderHandler()
