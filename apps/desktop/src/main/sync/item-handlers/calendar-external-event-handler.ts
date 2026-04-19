import { eq, isNull } from 'drizzle-orm'
import { calendarExternalEvents } from '@memry/db-schema/schema/calendar-external-events'
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
import { increment } from '../vector-clock'
import { createLogger } from '../../lib/logger'
import { BaseItemHandler } from './base-handler'
import type { ApplyContext, ApplyResult, DrizzleDb } from './types'

const log = createLogger('CalendarExternalEventHandler')
const CALENDAR_CHANGED = 'calendar:changed'

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
        const resolution = this.resolveClock(existing.clock as VectorClock | null, remoteClock)
        if (resolution.action === 'skip') {
          log.info('Skipping remote calendar external event update, local is newer', { itemId })
          return 'skipped'
        }

        // M5 nullable rich fields: distinguish "omitted" from "explicit null".
        const hasKey = (k: string): boolean => Object.prototype.hasOwnProperty.call(data, k)

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

      tx.insert(calendarExternalEvents)
        .values({
          id: itemId,
          sourceId: data.sourceId ?? 'unknown-source',
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

  buildPushPayload(db: DrizzleDb, itemId: string): string | null {
    const row = db
      .select()
      .from(calendarExternalEvents)
      .where(eq(calendarExternalEvents.id, itemId))
      .get()
    if (!row) return null
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
      recurrenceRule: (row.recurrenceRule as Record<string, unknown> | null) ?? null,
      attendees: (row.attendees as Array<Record<string, unknown>> | null) ?? null,
      reminders: (row.reminders as Record<string, unknown> | null) ?? null,
      visibility: row.visibility ?? null,
      colorId: row.colorId ?? null,
      conferenceData: (row.conferenceData as Record<string, unknown> | null) ?? null,
      rawPayload: (row.rawPayload as Record<string, unknown> | null) ?? null,
      archivedAt: row.archivedAt ?? null,
      clock: (row.clock as VectorClock) ?? undefined,
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
      const nextClock = increment({}, deviceId)
      db.update(calendarExternalEvents)
        .set({ clock: nextClock })
        .where(eq(calendarExternalEvents.id, item.id))
        .run()
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
