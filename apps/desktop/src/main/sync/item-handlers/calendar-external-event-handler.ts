import { eq, isNull } from 'drizzle-orm'
import { calendarExternalEvents } from '@memry/db-schema/schema/calendar-external-events'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import type {
  CalendarAttendee,
  CalendarConferenceData,
  CalendarReminders,
  CalendarVisibility
} from '@memry/db-schema/schema/calendar-events'
import { utcNow } from '@memry/shared/utc'
import {
  CalendarExternalEventSyncPayloadSchema,
  type CalendarExternalEventSyncPayload
} from '@memry/contracts/sync-payloads'
import type { VectorClock } from '@memry/contracts/sync-api'
import type { SyncQueueManager } from '../queue'
import { increment } from '@memry/sync-client/vector-clock'
import { createLogger } from '../../lib/logger'
import { BaseItemHandler } from './base-handler'
import { MissingSyncParentError } from './types'
import type { ApplyContext, ApplyResult, DrizzleDb } from './types'

const log = createLogger('CalendarExternalEventHandler')
const CALENDAR_CHANGED = 'calendar:changed'

/**
 * `calendar_external_events.source_id` is NOT NULL and FK-bound to
 * `calendar_sources` (ON DELETE cascade), so an event whose source has not
 * landed locally is unwritable. Surface it as a typed error naming the missing
 * id instead of SQLite's anonymous `FOREIGN KEY constraint failed` (#837).
 *
 * Why the classification matters: pull-coordinator routes only
 * `MissingSyncParentError` into `orphanedItems` → `repairOrphans`, which
 * re-fetches the parent by id (authoritative in a way the pull cursor window is
 * not) and then either replays the child or tombstones it. Any other error is
 * logged as "deferred retry failed — item skipped until next remote update" and
 * the item is dropped. An unchanged Google event never gets a next remote
 * update, so it would stay invisible forever while the calendar_source itself
 * syncs fine and the UI keeps reporting "connected".
 *
 * Backward compatibility: this only changes how an already-failing apply is
 * classified. The write threw before and throws now, from inside the same
 * transaction, so no row is written or mutated either way and no payload
 * written by an older app version is read differently. Throwing is precisely
 * what parks the item in `pendingApplyRetries`, so deferring cannot lose it:
 * it replays once its source arrives, and if the source is gone everywhere the
 * repair path tombstones it rather than re-pulling it forever.
 */
function requireCalendarSource(tx: DrizzleDb, eventId: string, sourceId: string): void {
  const parent = tx
    .select({ id: calendarSources.id })
    .from(calendarSources)
    .where(eq(calendarSources.id, sourceId))
    .get()
  if (!parent) {
    throw new MissingSyncParentError(
      'calendar_external_event',
      eventId,
      'calendar_source',
      sourceId
    )
  }
}

class CalendarExternalEventHandler extends BaseItemHandler<CalendarExternalEventSyncPayload> {
  readonly type = 'calendar_external_event' as const
  readonly schema = CalendarExternalEventSyncPayloadSchema

  applyUpsert(
    ctx: ApplyContext,
    itemId: string,
    data: CalendarExternalEventSyncPayload,
    clock: VectorClock
  ): ApplyResult {
    return ctx.db.transaction((tx): ApplyResult => {
      const existing = tx
        .select()
        .from(calendarExternalEvents)
        .where(eq(calendarExternalEvents.id, itemId))
        .get()
      const remoteClock = Object.keys(clock).length > 0 ? clock : (data.clock ?? {})
      const now = utcNow()

      if (existing) {
        const resolution = this.resolveClock(existing.clock, remoteClock)
        if (resolution.action === 'skip') {
          log.info('Skipping remote calendar external event update, local is newer', { itemId })
          return 'skipped'
        }

        // M5 nullable rich fields: distinguish "omitted" from "explicit null".
        const hasKey = (k: string): boolean => Object.prototype.hasOwnProperty.call(data, k)

        // An absent sourceId means "unchanged", and the existing parent is
        // already valid — only a supplied one can point somewhere that has not
        // landed yet (an event moved onto a newly added calendar).
        if (data.sourceId) requireCalendarSource(tx as unknown as DrizzleDb, itemId, data.sourceId)

        tx.update(calendarExternalEvents)
          .set({
            sourceId: data.sourceId ?? existing.sourceId,
            remoteEventId: data.remoteEventId ?? existing.remoteEventId,
            remoteEtag: data.remoteEtag ?? existing.remoteEtag,
            remoteUpdatedAt: data.remoteUpdatedAt ?? existing.remoteUpdatedAt,
            title: data.title ?? existing.title,
            description: data.description ?? existing.description,
            location: data.location ?? existing.location,
            startAt: data.startAt ?? existing.startAt,
            endAt: data.endAt ?? existing.endAt,
            timezone: data.timezone ?? existing.timezone,
            isAllDay: data.isAllDay ?? existing.isAllDay,
            status: data.status ?? existing.status,
            recurrenceRule: data.recurrenceRule ?? existing.recurrenceRule ?? null,
            attendees: hasKey('attendees')
              ? ((data.attendees as CalendarAttendee[] | null) ?? null)
              : (existing.attendees ?? null),
            reminders: hasKey('reminders')
              ? ((data.reminders as CalendarReminders | null) ?? null)
              : (existing.reminders ?? null),
            visibility: hasKey('visibility')
              ? ((data.visibility as CalendarVisibility | null) ?? null)
              : (existing.visibility ?? null),
            colorId: hasKey('colorId') ? (data.colorId ?? null) : (existing.colorId ?? null),
            conferenceData: hasKey('conferenceData')
              ? ((data.conferenceData as CalendarConferenceData | null) ?? null)
              : (existing.conferenceData ?? null),
            rawPayload: data.rawPayload ?? existing.rawPayload ?? null,
            archivedAt: data.archivedAt ?? existing.archivedAt,
            clock: resolution.mergedClock,
            modifiedAt: data.modifiedAt ?? now
          })
          .where(eq(calendarExternalEvents.id, itemId))
          .run()

        ctx.emit(CALENDAR_CHANGED, { entityType: 'calendar_external_event', id: itemId })
        return resolution.action === 'merge' ? 'conflict' : 'applied'
      }

      // A create must name its source. `source_id` is NOT NULL and FK-bound, so
      // there is no id we could invent to stand in for a missing one — the old
      // `?? 'unknown-source'` literal was exactly such an invention and could
      // only ever FK-fail. Report the absence as a missing parent with no id so
      // orphan repair asks the server, finds nothing, and tombstones the
      // unwritable event instead of the pull silently dropping it on every run.
      const sourceId = data.sourceId ?? ''
      requireCalendarSource(tx as unknown as DrizzleDb, itemId, sourceId)

      tx.insert(calendarExternalEvents)
        .values({
          id: itemId,
          sourceId,
          remoteEventId: data.remoteEventId ?? itemId,
          remoteEtag: data.remoteEtag ?? null,
          remoteUpdatedAt: data.remoteUpdatedAt ?? null,
          title: data.title ?? 'Untitled imported event',
          description: data.description ?? null,
          location: data.location ?? null,
          startAt: data.startAt ?? now,
          endAt: data.endAt ?? null,
          timezone: data.timezone ?? null,
          isAllDay: data.isAllDay ?? false,
          status: data.status ?? 'confirmed',
          recurrenceRule: data.recurrenceRule ?? null,
          attendees: (data.attendees as CalendarAttendee[] | null | undefined) ?? null,
          reminders: (data.reminders as CalendarReminders | null | undefined) ?? null,
          visibility: (data.visibility as CalendarVisibility | null | undefined) ?? null,
          colorId: data.colorId ?? null,
          conferenceData:
            (data.conferenceData as CalendarConferenceData | null | undefined) ?? null,
          rawPayload: data.rawPayload ?? null,
          archivedAt: data.archivedAt ?? null,
          clock: remoteClock,
          createdAt: data.createdAt ?? now,
          modifiedAt: data.modifiedAt ?? now
        })
        .run()

      ctx.emit(CALENDAR_CHANGED, { entityType: 'calendar_external_event', id: itemId })
      return 'applied'
    })
  }

  applyDelete(ctx: ApplyContext, itemId: string, clock?: VectorClock): 'applied' | 'skipped' {
    const existing = ctx.db
      .select()
      .from(calendarExternalEvents)
      .where(eq(calendarExternalEvents.id, itemId))
      .get()
    if (!existing) return 'skipped'

    if (clock && existing.clock) {
      const resolution = this.resolveClock(existing.clock as VectorClock | null, clock)
      if (resolution.action === 'skip' || resolution.action === 'merge') {
        log.info('Skipping remote calendar external event delete, local has unseen changes', {
          itemId
        })
        return 'skipped'
      }
    }

    ctx.db.delete(calendarExternalEvents).where(eq(calendarExternalEvents.id, itemId)).run()
    ctx.emit(CALENDAR_CHANGED, { entityType: 'calendar_external_event', id: itemId })
    return 'applied'
  }

  fetchLocal(db: DrizzleDb, itemId: string): Record<string, unknown> | undefined {
    return db
      .select()
      .from(calendarExternalEvents)
      .where(eq(calendarExternalEvents.id, itemId))
      .get() as Record<string, unknown> | undefined
  }

  /**
   * Stamp the first clock on a row that has none, and persist it.
   *
   * Shared by `seedUnclocked` (startup sweep) and `buildPushPayload` (per-push
   * repair) so both produce the same first-push clock. Persisting is
   * load-bearing: a clock invented for the payload alone would leave the row
   * NULL, and the next real edit would tick from `{}` to the SAME clock the
   * server already acked — a replay the server drops, losing the edit.
   */
  private stampFirstClock(db: DrizzleDb, itemId: string, deviceId: string): VectorClock {
    const clock = increment({}, deviceId)
    db.update(calendarExternalEvents)
      .set({ clock })
      .where(eq(calendarExternalEvents.id, itemId))
      .run()
    return clock
  }

  buildPushPayload(db: DrizzleDb, itemId: string, deviceId?: string): string | null {
    const row = db
      .select()
      .from(calendarExternalEvents)
      .where(eq(calendarExternalEvents.id, itemId))
      .get()
    if (!row) return null

    // #1215 repair for installs that already have the damage. Rows written
    // before the import seeded a clock are ALREADY in the queue, and
    // `seedUnclocked` only runs from `runInitialSeed` inside a full sync — an
    // incremental push cycle never reaches it, so the clock-less row is
    // re-sent and rejected on every attempt. Since one clock-less item fails
    // the whole batch at request level, that single row blocks all sync until
    // the next full sync. Repairing here drains the stuck queue on the very
    // next push, with no reset and no schema change.
    const rowClock = (row.clock as VectorClock | null) ?? null
    const clock = rowClock ?? (deviceId ? this.stampFirstClock(db, itemId, deviceId) : undefined)
    const payload: CalendarExternalEventSyncPayload = {
      sourceId: row.sourceId,
      remoteEventId: row.remoteEventId,
      remoteEtag: row.remoteEtag ?? null,
      remoteUpdatedAt: row.remoteUpdatedAt ?? null,
      title: row.title,
      description: row.description ?? null,
      location: row.location ?? null,
      startAt: row.startAt,
      endAt: row.endAt ?? null,
      timezone: row.timezone ?? null,
      isAllDay: row.isAllDay,
      status: row.status,
      recurrenceRule: row.recurrenceRule ?? null,
      attendees: (row.attendees as Array<Record<string, unknown>> | null) ?? null,
      reminders: (row.reminders as Record<string, unknown> | null) ?? null,
      visibility: row.visibility ?? null,
      colorId: row.colorId ?? null,
      conferenceData: (row.conferenceData as Record<string, unknown> | null) ?? null,
      rawPayload: row.rawPayload ?? null,
      archivedAt: row.archivedAt ?? null,
      clock,
      createdAt: row.createdAt,
      modifiedAt: row.modifiedAt
    }
    return JSON.stringify(payload)
  }

  seedUnclocked(db: DrizzleDb, deviceId: string, queue: SyncQueueManager): number {
    const items = db
      .select()
      .from(calendarExternalEvents)
      .where(isNull(calendarExternalEvents.clock))
      .all()
    for (const item of items) {
      const nextClock = this.stampFirstClock(db, item.id, deviceId)
      queue.enqueue({
        type: 'calendar_external_event',
        itemId: item.id,
        operation: 'create',
        payload: JSON.stringify({ ...item, clock: nextClock }),
        priority: 0
      })
    }
    return items.length
  }
}

export const calendarExternalEventHandler = new CalendarExternalEventHandler()
