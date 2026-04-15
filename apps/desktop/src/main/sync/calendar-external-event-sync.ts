import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import type * as schema from '@memry/db-schema/data-schema'
import { calendarExternalEvents } from '@memry/db-schema/schema/calendar-external-events'
import type { VectorClock } from '@memry/contracts/sync-api'
import { RecordSyncController, incrementClock, withIncrementedClock } from '@memry/sync-core'
import type { SyncQueueManager } from './queue'

type DrizzleDb = BetterSQLite3Database<typeof schema>

interface CalendarExternalEventSyncDeps {
  queue: SyncQueueManager
  db: DrizzleDb
  getDeviceId: () => string | null
}

let instance: CalendarExternalEventSyncService | null = null

export function initCalendarExternalEventSyncService(
  deps: CalendarExternalEventSyncDeps
): CalendarExternalEventSyncService {
  instance = new CalendarExternalEventSyncService(deps)
  return instance
}

export function getCalendarExternalEventSyncService(): CalendarExternalEventSyncService | null {
  return instance
}

export function resetCalendarExternalEventSyncService(): void {
  instance = null
}

export class CalendarExternalEventSyncService {
  private controller: RecordSyncController<Record<string, unknown>, [], [string?]>

  constructor(deps: CalendarExternalEventSyncDeps) {
    this.controller = new RecordSyncController({
      type: 'calendar_external_event',
      queue: deps.queue,
      getDeviceId: deps.getDeviceId,
      load: (id) =>
        deps.db
          .select()
          .from(calendarExternalEvents)
          .where(eq(calendarExternalEvents.id, id))
          .get() as Record<string, unknown> | undefined,
      applyLocalChange: ({ itemId, local, deviceId }) => {
        const existingClock = (local.clock as VectorClock) ?? {}
        const nextClock = incrementClock(existingClock, deviceId)

        deps.db
          .update(calendarExternalEvents)
          .set({ clock: nextClock })
          .where(eq(calendarExternalEvents.id, itemId))
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
