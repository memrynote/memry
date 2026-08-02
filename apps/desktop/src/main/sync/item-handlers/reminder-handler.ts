import { eq, isNull } from 'drizzle-orm'
import { reminders } from '@memry/db-schema/schema/reminders'
import { ReminderSyncPayloadSchema, type ReminderSyncPayload } from '@memry/contracts/sync-payloads'
import { ReminderChannels } from '@memry/contracts/ipc-channels'
import type { VectorClock } from '@memry/contracts/sync-api'
import { utcNow } from '@memry/shared/utc'
import type { SyncQueueManager } from '../queue'
import { increment } from '../vector-clock'
import { createLogger } from '../../lib/logger'
import { toOutboundReminderPayload } from '../reminder-outbound'
import { BaseItemHandler } from './base-handler'
import type { ApplyContext, ApplyResult, DrizzleDb } from './types'

const log = createLogger('ReminderHandler')

/**
 * `triggeredAt` is intentionally never read from or written by the payload.
 * It records that THIS device showed an OS notification. Syncing it would make
 * a device that never displayed the reminder believe it already had, silently
 * swallowing the notification.
 *
 * `status: 'triggered'` is device-local for the same reason: it just means
 * THIS device's scheduler fired. Outbound payloads normalize it to 'pending'
 * (see reminder-outbound.ts) so a device that hasn't reached remindAt yet
 * doesn't get talked out of its own notification. Real user intent —
 * 'dismissed' / 'snoozed' — still syncs unchanged.
 *
 * `remindAt` on an ANCHORED `note_date` row is device-local too: it is derived
 * from the note's date pill in the host OS timezone. The ANCHORED qualifier is
 * load-bearing — unanchored `note_date` rows carry a user-supplied time and
 * must keep syncing. See reminder-outbound.ts.
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

        // `remindAt` on an ANCHORED note_date row is device-local (derived from
        // the note's date pill in THIS device's timezone — see
        // reminder-outbound.ts). Current clients omit it from the payload, but
        // one running an older build, or a payload queued before this rule
        // existed, still sends it. Ignoring it here is what stops the two
        // devices contending over the value and resetting each other's dismiss.
        // Unanchored note_date rows are ordinary user intent with a
        // user-supplied time, so theirs must keep syncing.
        const localRemindAt =
          (data.targetType ?? existing.targetType) === 'note_date' &&
          !!(data.anchorId ?? existing.anchorId)
        // triggeredAt is deliberately absent from this set — device-local.
        tx.update(reminders)
          .set({
            targetType: data.targetType ?? existing.targetType,
            targetId: data.targetId ?? existing.targetId,
            remindAt: localRemindAt ? existing.remindAt : (data.remindAt ?? existing.remindAt),
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

      // An ANCHORED note_date row is OWNED by the local reconciler
      // (notes/note-date-reminders.ts): it derives the row — including its
      // device-local remindAt — from the note's date pills, and that note
      // content already syncs via CRDT. Sync carries only the user's dismissal
      // state for these rows, so there is nothing to insert here. With remindAt
      // absent from the payload an insert would have to invent a time, and
      // `now` would fire the reminder immediately. Once this device's copy of
      // the note lands, its reconciler creates the row correctly and later
      // merges carry the dismissal.
      //
      // Unanchored note_date rows are NOT reconciler-owned — no date pill maps
      // to them, so nothing would ever recreate one here. Skipping those would
      // be silent cross-device data loss, since the pull cursor moves past a
      // skipped item.
      if (data.targetType === 'note_date' && data.anchorId) {
        log.info('Skipping remote note_date reminder insert, derived locally from note content', {
          itemId
        })
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
    return JSON.stringify(toOutboundReminderPayload(reminder))
  }

  markPushSynced(db: DrizzleDb, itemId: string): void {
    db.update(reminders).set({ syncedAt: utcNow() }).where(eq(reminders.id, itemId)).run()
  }

  seedUnclocked(db: DrizzleDb, deviceId: string, queue: SyncQueueManager): number {
    const items = db.select().from(reminders).where(isNull(reminders.clock)).all()
    for (const item of items) {
      const clock = increment({}, deviceId)
      db.update(reminders).set({ clock }).where(eq(reminders.id, item.id)).run()
      queue.enqueue({
        type: 'reminder',
        itemId: item.id,
        operation: 'create',
        payload: JSON.stringify({ ...toOutboundReminderPayload(item), clock }),
        priority: 0
      })
    }
    return items.length
  }
}

export const reminderHandler = new ReminderHandler()
