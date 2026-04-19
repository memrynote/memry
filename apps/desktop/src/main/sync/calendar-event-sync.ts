import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import type * as schema from '@memry/db-schema/data-schema'
import { calendarEvents } from '@memry/db-schema/schema/calendar-events'
import type { FieldClocks, VectorClock } from '@memry/contracts/sync-api'
import { RecordSyncController, incrementClock, withIncrementedClock } from '@memry/sync-core'
import { initAllFieldClocks } from './field-merge'
import { CALENDAR_EVENT_SYNCABLE_FIELDS } from '../calendar/field-merge-calendar'
import type { SyncQueueManager } from './queue'

type DrizzleDb = BetterSQLite3Database<typeof schema>

interface CalendarEventSyncDeps {
  queue: SyncQueueManager
  db: DrizzleDb
  getDeviceId: () => string | null
}

let instance: CalendarEventSyncService | null = null

export function initCalendarEventSyncService(
  deps: CalendarEventSyncDeps
): CalendarEventSyncService {
  instance = new CalendarEventSyncService(deps)
  return instance
}

export function getCalendarEventSyncService(): CalendarEventSyncService | null {
  return instance
}

export function resetCalendarEventSyncService(): void {
  instance = null
}

export class CalendarEventSyncService {
  private controller: RecordSyncController<Record<string, unknown>, [string[]?], [string?]>

  constructor(deps: CalendarEventSyncDeps) {
    this.controller = new RecordSyncController({
      type: 'calendar_event',
      queue: deps.queue,
      getDeviceId: deps.getDeviceId,
      load: (id) =>
        deps.db.select().from(calendarEvents).where(eq(calendarEvents.id, id)).get() as
          | Record<string, unknown>
          | undefined,
      applyLocalChange: ({ itemId, local, deviceId, operation, extra }) => {
        const changedFields = extra[0]
        const existingClock = (local.clock as VectorClock) ?? {}
        const nextClock = incrementClock(existingClock, deviceId)

        let fieldClocks = (local.fieldClocks as FieldClocks | null) ?? null
        if (!fieldClocks) {
          fieldClocks = initAllFieldClocks(existingClock, CALENDAR_EVENT_SYNCABLE_FIELDS)
        }

        const fieldsToIncrement =
          operation === 'create'
            ? CALENDAR_EVENT_SYNCABLE_FIELDS
            : (changedFields ?? CALENDAR_EVENT_SYNCABLE_FIELDS)

        const updatedFieldClocks: FieldClocks = { ...fieldClocks }
        for (const field of fieldsToIncrement) {
          updatedFieldClocks[field] = incrementClock(updatedFieldClocks[field] ?? {}, deviceId)
        }

        deps.db
          .update(calendarEvents)
          .set({ clock: nextClock, fieldClocks: updatedFieldClocks })
          .where(eq(calendarEvents.id, itemId))
          .run()

        return { ...local, clock: nextClock, fieldClocks: updatedFieldClocks }
      },
      serialize: (local) => local,
      buildDeletePayload: ({ itemId, local, extra, deviceId }) => {
        const snapshotPayload = extra[0]
        if (snapshotPayload) return withIncrementedClock(snapshotPayload, deviceId)
        if (local) return withIncrementedClock(JSON.stringify(local), deviceId)
        return JSON.stringify({ id: itemId, clock: incrementClock({}, deviceId) })
      }
    })
  }

  enqueueCreate(id: string): void {
    this.controller.enqueueCreate(id)
  }

  enqueueUpdate(id: string, changedFields?: string[]): void {
    this.controller.enqueueUpdate(id, changedFields)
  }

  enqueueDelete(id: string, snapshotPayload?: string): void {
    this.controller.enqueueDelete(id, snapshotPayload)
  }
}
