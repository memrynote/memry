import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import type * as schema from '@memry/db-schema/data-schema'
import { calendarEvents } from '@memry/db-schema/schema/calendar-events'
import type { VectorClock } from '@memry/contracts/sync-api'
import { RecordSyncController, incrementClock, withIncrementedClock } from '@memry/sync-core'
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
  private controller: RecordSyncController<Record<string, unknown>, [], [string?]>

  constructor(deps: CalendarEventSyncDeps) {
    this.controller = new RecordSyncController({
      type: 'calendar_event',
      queue: deps.queue,
      getDeviceId: deps.getDeviceId,
      load: (id) =>
        deps.db.select().from(calendarEvents).where(eq(calendarEvents.id, id)).get() as
          | Record<string, unknown>
          | undefined,
      applyLocalChange: ({ itemId, local, deviceId }) => {
        const existingClock = (local.clock as VectorClock) ?? {}
        const nextClock = incrementClock(existingClock, deviceId)

        deps.db
          .update(calendarEvents)
          .set({ clock: nextClock })
          .where(eq(calendarEvents.id, itemId))
          .run()

        return { ...local, clock: nextClock }
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

  enqueueUpdate(id: string): void {
    this.controller.enqueueUpdate(id)
  }

  enqueueDelete(id: string, snapshotPayload?: string): void {
    this.controller.enqueueDelete(id, snapshotPayload)
  }
}
