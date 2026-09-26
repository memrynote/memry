import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import { eq } from 'drizzle-orm'
import { reminders } from '@memry/db-schema/schema/reminders'
import type { VectorClock } from '@memry/contracts/sync-api'
import { RecordSyncController, incrementClock, withIncrementedClock } from '@memry/sync-core'
import { toOutboundReminderPayload } from '@memry/sync-client/reminder-outbound'
import { recoverOfflineDocClock } from './offline-clock'
import type { SyncQueueManager } from './queue'

interface ReminderSyncDeps {
  queue: SyncQueueManager
  db: DrizzleDb
  getDeviceId: () => string | null
}

let instance: ReminderSyncService | null = null

export function initReminderSyncService(deps: ReminderSyncDeps): ReminderSyncService {
  instance = new ReminderSyncService(deps)
  return instance
}

export function getReminderSyncService(): ReminderSyncService | null {
  return instance
}

export function resetReminderSyncService(): void {
  instance = null
}

export class ReminderSyncService {
  private controller: RecordSyncController<Record<string, unknown>, [], [string]>

  constructor(deps: ReminderSyncDeps) {
    const load = (reminderId: string): Record<string, unknown> | undefined =>
      deps.db.select().from(reminders).where(eq(reminders.id, reminderId)).get() as
        Record<string, unknown> | undefined

    this.controller = new RecordSyncController({
      type: 'reminder',
      queue: deps.queue,
      getDeviceId: deps.getDeviceId,
      load,
      applyLocalChange: ({ itemId, local, deviceId }) => {
        const existingClock = (local.clock as VectorClock) ?? {}
        const newClock = incrementClock(existingClock, deviceId)

        deps.db.update(reminders).set({ clock: newClock }).where(eq(reminders.id, itemId)).run()

        return { ...local, clock: newClock }
      },
      // Device-local fields (triggeredAt, status='triggered', and a note_date
      // row's derived remindAt) never go out. All four outbound sites share
      // one implementation so they cannot drift — see reminder-outbound.ts.
      serialize: (local) => toOutboundReminderPayload(local),
      recoverPendingChange: (reminderId, deviceId) =>
        recoverOfflineDocClock(load(reminderId), deviceId, (clock) =>
          deps.db.update(reminders).set({ clock }).where(eq(reminders.id, reminderId)).run()
        ),
      serializeRecovered: (local) => toOutboundReminderPayload(local),
      buildDeletePayload: ({ extra, deviceId }) => withIncrementedClock(extra[0], deviceId)
    })
  }

  enqueueCreate(reminderId: string): void {
    this.controller.enqueueCreate(reminderId)
  }

  enqueueUpdate(reminderId: string): void {
    this.controller.enqueueUpdate(reminderId)
  }

  enqueueRecoveredUpdate(reminderId: string): void {
    this.controller.enqueueRecoveredUpdate(reminderId)
  }

  enqueueDelete(reminderId: string, snapshotPayload: string): void {
    this.controller.enqueueDelete(reminderId, snapshotPayload)
  }
}
