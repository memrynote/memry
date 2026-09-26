import { and, eq, isNull, notInArray } from 'drizzle-orm'
import { DEVICE_LOCAL_CALENDAR_PROVIDERS } from '@memry/contracts/calendar-api'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import { utcNow } from '@memry/shared/utc'
import {
  CalendarSourceSyncPayloadSchema,
  type CalendarSourceSyncPayload
} from '@memry/contracts/sync-payloads'
import type { VectorClock } from '@memry/contracts/sync-api'
import type { SyncQueueManager } from '../queue'
import { nextLocalClock } from '@memry/sync-client/tombstone-clocks'
import { recordDeclinedRef } from '../declined-refs'
import { createLogger } from '../logging'
import { BaseItemHandler } from './base-handler'
import type { ApplyContext, ApplyResult, DrizzleDb } from './types'

const log = createLogger('CalendarSourceHandler')
const CALENDAR_CHANGED = 'calendar:changed'

class CalendarSourceHandler extends BaseItemHandler<CalendarSourceSyncPayload> {
  readonly type = 'calendar_source' as const
  readonly schema = CalendarSourceSyncPayloadSchema

  applyUpsert(
    ctx: ApplyContext,
    itemId: string,
    data: CalendarSourceSyncPayload,
    clock: VectorClock
  ): ApplyResult {
    return ctx.db.transaction((tx): ApplyResult => {
      const existing = tx.select().from(calendarSources).where(eq(calendarSources.id, itemId)).get()
      const remoteClock = Object.keys(clock).length > 0 ? clock : (data.clock ?? {})
      const now = utcNow()

      if (existing) {
        const resolution = this.resolveUpsertClock(ctx, itemId, existing.clock, remoteClock, data)
        if (resolution.action === 'skip') {
          log.info('Skipping remote calendar source update, local is newer', { itemId })
          return 'skipped'
        }

        tx.update(calendarSources)
          .set({
            provider: data.provider ?? existing.provider,
            kind: data.kind ?? existing.kind,
            accountId: data.accountId ?? existing.accountId,
            remoteId: data.remoteId ?? existing.remoteId,
            title: data.title ?? existing.title,
            timezone: data.timezone ?? existing.timezone,
            color: data.color ?? existing.color,
            isPrimary: data.isPrimary ?? existing.isPrimary,
            isSelected: data.isSelected ?? existing.isSelected,
            isMemryManaged: data.isMemryManaged ?? existing.isMemryManaged,
            syncCursor: data.syncCursor ?? existing.syncCursor,
            syncStatus: data.syncStatus ?? existing.syncStatus,
            lastSyncedAt: data.lastSyncedAt ?? existing.lastSyncedAt,
            metadata: data.metadata ?? existing.metadata ?? null,
            archivedAt: data.archivedAt ?? existing.archivedAt,
            clock: resolution.mergedClock,
            modifiedAt: data.modifiedAt ?? now
          })
          .where(eq(calendarSources.id, itemId))
          .run()

        ctx.emit(CALENDAR_CHANGED, { entityType: 'calendar_source', id: itemId })
        return resolution.action === 'merge' ? 'conflict' : 'applied'
      }

      const provider = data.provider ?? 'google'
      const kind = data.kind ?? 'calendar'
      const remoteId = data.remoteId ?? itemId
      // Two devices can mint different ids for one (provider, kind, remote id),
      // and the natural-key UNIQUE index rejects the second insert. The row we
      // hold already is that source, so decline the duplicate id.
      const sameSource = tx
        .select({ id: calendarSources.id })
        .from(calendarSources)
        .where(
          and(
            eq(calendarSources.provider, provider),
            eq(calendarSources.kind, kind),
            eq(calendarSources.remoteId, remoteId)
          )
        )
        .get()
      if (sameSource) {
        log.info('Declining remote calendar source, its natural key is held by another id', {
          itemId,
          localId: sameSource.id
        })
        recordDeclinedRef(tx, { type: 'calendar_source', id: itemId })
        return 'skipped'
      }

      tx.insert(calendarSources)
        .values({
          id: itemId,
          provider,
          kind,
          accountId: data.accountId ?? null,
          remoteId,
          title: data.title ?? 'Untitled calendar',
          timezone: data.timezone ?? null,
          color: data.color ?? null,
          isPrimary: data.isPrimary ?? false,
          isSelected: data.isSelected ?? false,
          isMemryManaged: data.isMemryManaged ?? false,
          syncCursor: data.syncCursor ?? null,
          syncStatus: data.syncStatus ?? 'idle',
          lastSyncedAt: data.lastSyncedAt ?? null,
          metadata: data.metadata ?? null,
          archivedAt: data.archivedAt ?? null,
          clock: remoteClock,
          createdAt: data.createdAt ?? now,
          modifiedAt: data.modifiedAt ?? now
        })
        .run()

      ctx.emit(CALENDAR_CHANGED, { entityType: 'calendar_source', id: itemId })
      return 'applied'
    })
  }

  applyDelete(ctx: ApplyContext, itemId: string, clock?: VectorClock): 'applied' | 'skipped' {
    const existing = ctx.db
      .select()
      .from(calendarSources)
      .where(eq(calendarSources.id, itemId))
      .get()
    if (!existing) return 'skipped'

    if (clock && existing.clock) {
      const resolution = this.resolveDeleteClock(existing.clock as VectorClock | null, clock)
      if (resolution.skip) {
        log.info('Skipping remote calendar source delete, local is ahead of the tombstone', {
          itemId
        })
        return 'skipped'
      }
    }

    ctx.db.delete(calendarSources).where(eq(calendarSources.id, itemId)).run()
    ctx.emit(CALENDAR_CHANGED, { entityType: 'calendar_source', id: itemId })
    return 'applied'
  }

  fetchLocal(db: DrizzleDb, itemId: string): Record<string, unknown> | undefined {
    return db.select().from(calendarSources).where(eq(calendarSources.id, itemId)).get() as
      Record<string, unknown> | undefined
  }

  buildPushPayload(db: DrizzleDb, itemId: string): string | null {
    const row = db.select().from(calendarSources).where(eq(calendarSources.id, itemId)).get()
    if (!row) return null
    const payload: CalendarSourceSyncPayload = {
      provider: row.provider,
      kind: row.kind,
      accountId: row.accountId ?? null,
      remoteId: row.remoteId,
      title: row.title,
      timezone: row.timezone ?? null,
      color: row.color ?? null,
      isPrimary: row.isPrimary,
      isSelected: row.isSelected,
      isMemryManaged: row.isMemryManaged,
      syncCursor: row.syncCursor ?? null,
      syncStatus: row.syncStatus,
      lastSyncedAt: row.lastSyncedAt ?? null,
      metadata: row.metadata ?? null,
      archivedAt: row.archivedAt ?? null,
      clock: (row.clock as VectorClock) ?? undefined,
      createdAt: row.createdAt,
      modifiedAt: row.modifiedAt
    }
    return JSON.stringify(payload)
  }

  seedUnclocked(db: DrizzleDb, deviceId: string, queue: SyncQueueManager): number {
    // Source rows of a device-local provider (`sourceScope: 'device'`) never
    // leave the device that wrote them, so other platforms and older builds
    // never receive them. They stay unclocked and out of the queue.
    const localSources = [...DEVICE_LOCAL_CALENDAR_PROVIDERS.sources]
    const items = db
      .select()
      .from(calendarSources)
      .where(
        and(
          isNull(calendarSources.clock),
          localSources.length === 0 ? undefined : notInArray(calendarSources.provider, localSources)
        )
      )
      .all()
    for (const item of items) {
      const nextClock = nextLocalClock(db, 'calendar_source', item.id, null, deviceId, 'create')
      db.update(calendarSources)
        .set({ clock: nextClock })
        .where(eq(calendarSources.id, item.id))
        .run()
      queue.enqueue({
        type: 'calendar_source',
        itemId: item.id,
        operation: 'create',
        payload: JSON.stringify({ ...item, clock: nextClock }),
        priority: 0
      })
    }
    return items.length
  }
}

export const calendarSourceHandler = new CalendarSourceHandler()
