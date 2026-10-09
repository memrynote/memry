import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import { eq } from 'drizzle-orm'
import { calendarBindings } from '@memry/db-schema/schema/calendar-bindings'
import type { VectorClock } from '@memry/contracts/sync-api'
import { RecordSyncController, withIncrementedClock } from '@memry/sync-core'
import type { SyncQueueManager } from './queue'
import { recoverOfflineDocClock } from './offline-clock'
import { deleteFromLocalRow } from './delete-fallback'
import { nextLocalClock } from './tombstone-clocks'

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
          Record<string, unknown> | undefined,
      applyLocalChange: ({ itemId, local, deviceId, operation }) => {
        const nextClock = nextLocalClock(
          deps.db,
          'calendar_binding',
          itemId,
          local.clock as VectorClock | null,
          deviceId,
          operation
        )

        deps.db
          .update(calendarBindings)
          .set({ clock: nextClock })
          .where(eq(calendarBindings.id, itemId))
          .run()

        return { ...local, clock: nextClock }
      },
      // #2897: edits queued with no device id tick `_offline`; rebind them
      // before the first push (chapter 06 §6.6).
      recoverPendingChange: (itemId, deviceId) =>
        recoverOfflineDocClock(
          deps.db.select().from(calendarBindings).where(eq(calendarBindings.id, itemId)).get() as
            Record<string, unknown> | undefined,
          deviceId,
          (clock) =>
            deps.db
              .update(calendarBindings)
              .set({ clock })
              .where(eq(calendarBindings.id, itemId))
              .run()
        ),
      serialize: (local) => local,
      buildDeletePayload: ({ itemId, local, extra, deviceId }) => {
        const snapshotPayload = extra[0]
        if (snapshotPayload) return withIncrementedClock(snapshotPayload, deviceId)
        return deleteFromLocalRow('calendar_binding', itemId, local, deviceId)
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
