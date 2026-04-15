import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import type * as schema from '@memry/db-schema/data-schema'
import { calendarBindings } from '@memry/db-schema/schema/calendar-bindings'
import type { VectorClock } from '@memry/contracts/sync-api'
import { RecordSyncController, incrementClock, withIncrementedClock } from '@memry/sync-core'
import type { SyncQueueManager } from './queue'

type DrizzleDb = BetterSQLite3Database<typeof schema>

interface CalendarBindingSyncDeps {
  queue: SyncQueueManager
  db: DrizzleDb
  getDeviceId: () => string | null
}

let instance: CalendarBindingSyncService | null = null

export function initCalendarBindingSyncService(
  deps: CalendarBindingSyncDeps
): CalendarBindingSyncService {
  instance = new CalendarBindingSyncService(deps)
  return instance
}

export function getCalendarBindingSyncService(): CalendarBindingSyncService | null {
  return instance
}

export function resetCalendarBindingSyncService(): void {
  instance = null
}

export class CalendarBindingSyncService {
  private controller: RecordSyncController<Record<string, unknown>, [], [string?]>

  constructor(deps: CalendarBindingSyncDeps) {
    this.controller = new RecordSyncController({
      type: 'calendar_binding',
      queue: deps.queue,
      getDeviceId: deps.getDeviceId,
      load: (id) =>
        deps.db.select().from(calendarBindings).where(eq(calendarBindings.id, id)).get() as
          | Record<string, unknown>
          | undefined,
      applyLocalChange: ({ itemId, local, deviceId }) => {
        const existingClock = (local.clock as VectorClock) ?? {}
        const nextClock = incrementClock(existingClock, deviceId)

        deps.db
          .update(calendarBindings)
          .set({ clock: nextClock })
          .where(eq(calendarBindings.id, itemId))
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
