import { eq, isNull } from 'drizzle-orm'
import { calendarEvents, type CalendarEvent } from '@memry/db-schema/schema/calendar-events'
import { utcNow } from '@memry/shared/utc'
import {
  CalendarEventSyncPayloadSchema,
  type CalendarEventSyncPayload
} from '@memry/contracts/sync-payloads'
import type { FieldClocks, VectorClock } from '@memry/contracts/sync-api'
import type { SyncQueueManager } from '../queue'
import { increment } from '../vector-clock'
import { initAllFieldClocks } from '../field-merge'
import {
  CALENDAR_EVENT_SYNCABLE_FIELDS,
  mergeCalendarEventFields
} from '../../calendar/field-merge-calendar'
import { createLogger } from '../../lib/logger'
import { BaseItemHandler } from './base-handler'
import type { ApplyContext, ApplyResult, DrizzleDb } from './types'

const log = createLogger('CalendarEventHandler')
const CALENDAR_CHANGED = 'calendar:changed'

class CalendarEventHandler extends BaseItemHandler<CalendarEventSyncPayload> {
  readonly type = 'calendar_event' as const
  readonly schema = CalendarEventSyncPayloadSchema

  applyUpsert(
    ctx: ApplyContext,
    itemId: string,
    data: CalendarEventSyncPayload,
    clock: VectorClock
  ): ApplyResult {
    return ctx.db.transaction((tx): ApplyResult => {
      const existing = tx.select().from(calendarEvents).where(eq(calendarEvents.id, itemId)).get()
      const remoteClock = Object.keys(clock).length > 0 ? clock : (data.clock ?? {})
      const remoteFieldClocks = data.fieldClocks ?? null
      const now = utcNow()

      if (existing) {
        const resolution = this.resolveClock(existing.clock as VectorClock | null, remoteClock)
        if (resolution.action === 'skip') {
          log.info('Skipping remote calendar event update, local is newer', { itemId })
          return 'skipped'
        }

        if (resolution.action === 'merge') {
          const localFC =
            (existing.fieldClocks as FieldClocks | null) ??
            initAllFieldClocks(
              (existing.clock as VectorClock | null) ?? {},
              CALENDAR_EVENT_SYNCABLE_FIELDS
            )
          const remoteFC =
            remoteFieldClocks ?? initAllFieldClocks(remoteClock, CALENDAR_EVENT_SYNCABLE_FIELDS)

          const remoteForMerge: Record<string, unknown> = {}
          for (const field of CALENDAR_EVENT_SYNCABLE_FIELDS) {
            const remoteVal = (data as Record<string, unknown>)[field]
            remoteForMerge[field] =
              remoteVal === undefined ? (existing as Record<string, unknown>)[field] : remoteVal
          }

          const result = mergeCalendarEventFields(
            existing as Record<string, unknown>,
            remoteForMerge,
            localFC,
            remoteFC
          )

          tx.update(calendarEvents)
            .set({
              ...result.merged,
              archivedAt: data.archivedAt ?? existing.archivedAt,
              clock: resolution.mergedClock,
              fieldClocks: result.mergedFieldClocks,
              modifiedAt: data.modifiedAt ?? now
            })
            .where(eq(calendarEvents.id, itemId))
            .run()

          ctx.emit(CALENDAR_CHANGED, { entityType: 'calendar_event', id: itemId })
          return result.hadConflicts ? 'conflict' : 'applied'
        }

        const appliedFC =
          remoteFieldClocks ?? initAllFieldClocks(remoteClock, CALENDAR_EVENT_SYNCABLE_FIELDS)

        tx.update(calendarEvents)
          .set({
            title: data.title ?? existing.title,
            description: data.description ?? existing.description,
            location: data.location ?? existing.location,
            startAt: data.startAt ?? existing.startAt,
            endAt: data.endAt ?? existing.endAt,
            timezone: data.timezone ?? existing.timezone,
            isAllDay: data.isAllDay ?? existing.isAllDay,
            recurrenceRule: data.recurrenceRule ?? existing.recurrenceRule ?? null,
            recurrenceExceptions:
              data.recurrenceExceptions ?? existing.recurrenceExceptions ?? null,
            attendees:
              (data.attendees as CalendarEvent['attendees'] | undefined) ??
              existing.attendees ??
              null,
            reminders:
              (data.reminders as CalendarEvent['reminders'] | undefined) ??
              existing.reminders ??
              null,
            visibility: data.visibility ?? existing.visibility ?? null,
            colorId: data.colorId ?? existing.colorId ?? null,
            conferenceData:
              (data.conferenceData as CalendarEvent['conferenceData'] | undefined) ??
              existing.conferenceData ??
              null,
            archivedAt: data.archivedAt ?? existing.archivedAt,
            clock: resolution.mergedClock,
            fieldClocks: appliedFC,
            modifiedAt: data.modifiedAt ?? now
          })
          .where(eq(calendarEvents.id, itemId))
          .run()

        ctx.emit(CALENDAR_CHANGED, { entityType: 'calendar_event', id: itemId })
        return 'applied'
      }

      const insertedFC =
        remoteFieldClocks ?? initAllFieldClocks(remoteClock, CALENDAR_EVENT_SYNCABLE_FIELDS)

      tx.insert(calendarEvents)
        .values({
          id: itemId,
          title: data.title ?? 'Untitled event',
          description: data.description ?? null,
          location: data.location ?? null,
          startAt: data.startAt ?? now,
          endAt: data.endAt ?? null,
          timezone: data.timezone ?? 'UTC',
          isAllDay: data.isAllDay ?? false,
          recurrenceRule: data.recurrenceRule ?? null,
          recurrenceExceptions: data.recurrenceExceptions ?? null,
          attendees: (data.attendees as CalendarEvent['attendees'] | undefined) ?? null,
          reminders: (data.reminders as CalendarEvent['reminders'] | undefined) ?? null,
          visibility: data.visibility ?? null,
          colorId: data.colorId ?? null,
          conferenceData:
            (data.conferenceData as CalendarEvent['conferenceData'] | undefined) ?? null,
          archivedAt: data.archivedAt ?? null,
          clock: remoteClock,
          fieldClocks: insertedFC,
          createdAt: data.createdAt ?? now,
          modifiedAt: data.modifiedAt ?? now
        })
        .run()

      ctx.emit(CALENDAR_CHANGED, { entityType: 'calendar_event', id: itemId })
      return 'applied'
    })
  }

  applyDelete(ctx: ApplyContext, itemId: string, clock?: VectorClock): 'applied' | 'skipped' {
    const existing = ctx.db.select().from(calendarEvents).where(eq(calendarEvents.id, itemId)).get()
    if (!existing) return 'skipped'

    if (clock && existing.clock) {
      const resolution = this.resolveClock(existing.clock as VectorClock | null, clock)
      if (resolution.action === 'skip' || resolution.action === 'merge') {
        log.info('Skipping remote calendar event delete, local has unseen changes', { itemId })
        return 'skipped'
      }
    }

    ctx.db.delete(calendarEvents).where(eq(calendarEvents.id, itemId)).run()
    ctx.emit(CALENDAR_CHANGED, { entityType: 'calendar_event', id: itemId })
    return 'applied'
  }

  fetchLocal(db: DrizzleDb, itemId: string): Record<string, unknown> | undefined {
    return db.select().from(calendarEvents).where(eq(calendarEvents.id, itemId)).get() as
      | Record<string, unknown>
      | undefined
  }

  buildPushPayload(db: DrizzleDb, itemId: string): string | null {
    const row = db.select().from(calendarEvents).where(eq(calendarEvents.id, itemId)).get()
    if (!row) return null
    const payload: CalendarEventSyncPayload = {
      title: row.title,
      description: row.description ?? null,
      location: row.location ?? null,
      startAt: row.startAt,
      endAt: row.endAt ?? null,
      timezone: row.timezone,
      isAllDay: row.isAllDay,
      recurrenceRule: (row.recurrenceRule as Record<string, unknown> | null) ?? null,
      recurrenceExceptions: (row.recurrenceExceptions as string[] | null) ?? null,
      attendees: (row.attendees as Array<Record<string, unknown>> | null) ?? null,
      reminders: (row.reminders as Record<string, unknown> | null) ?? null,
      visibility: row.visibility ?? null,
      colorId: row.colorId ?? null,
      conferenceData: (row.conferenceData as Record<string, unknown> | null) ?? null,
      archivedAt: row.archivedAt ?? null,
      clock: (row.clock as VectorClock) ?? undefined,
      fieldClocks: (row.fieldClocks as FieldClocks | null) ?? undefined,
      createdAt: row.createdAt,
      modifiedAt: row.modifiedAt
    }
    return JSON.stringify(payload)
  }

  seedUnclocked(db: DrizzleDb, deviceId: string, queue: SyncQueueManager): number {
    const items = db.select().from(calendarEvents).where(isNull(calendarEvents.clock)).all()
    for (const item of items) {
      const nextClock = increment({}, deviceId)
      const fieldClocks = initAllFieldClocks(nextClock, CALENDAR_EVENT_SYNCABLE_FIELDS)
      db.update(calendarEvents)
        .set({ clock: nextClock, fieldClocks })
        .where(eq(calendarEvents.id, item.id))
        .run()
      queue.enqueue({
        type: 'calendar_event',
        itemId: item.id,
        operation: 'create',
        payload: JSON.stringify({ ...item, clock: nextClock, fieldClocks }),
        priority: 0
      })
    }
    return items.length
  }
}

export const calendarEventHandler = new CalendarEventHandler()
