import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import type * as schema from '@memry/db-schema/data-schema'
import { taskActivity } from '@memry/db-schema/schema/task-activity'
import type { VectorClock } from '@memry/contracts/sync-api'
import { RecordSyncController, incrementClock } from '@memry/sync-core'
import type { SyncQueueManager } from './queue'

type DrizzleDb = BetterSQLite3Database<typeof schema>

interface TaskActivitySyncDeps {
  queue: SyncQueueManager
  db: DrizzleDb
  getDeviceId: () => string | null
}

let instance: TaskActivitySyncService | null = null

export function initTaskActivitySyncService(deps: TaskActivitySyncDeps): TaskActivitySyncService {
  instance = new TaskActivitySyncService(deps)
  return instance
}

export function getTaskActivitySyncService(): TaskActivitySyncService | null {
  return instance
}

export function resetTaskActivitySyncService(): void {
  instance = null
}

/**
 * Activity rows are append-only, so this service intentionally exposes
 * `enqueueCreate` and nothing else.
 *
 * - There is no update path: a row is never edited after it is written.
 * - There is no delete path: rows leave by the retention cutoff, which every
 *   device applies independently from the same age rule. Pushing those deletes
 *   would double the traffic to reach a state the peers already arrive at.
 */
export class TaskActivitySyncService {
  private controller: RecordSyncController<Record<string, unknown>, [], [string]>

  constructor(deps: TaskActivitySyncDeps) {
    this.controller = new RecordSyncController({
      type: 'task_activity',
      queue: deps.queue,
      getDeviceId: deps.getDeviceId,
      load: (activityId) =>
        deps.db.select().from(taskActivity).where(eq(taskActivity.id, activityId)).get() as
          Record<string, unknown> | undefined,
      applyLocalChange: ({ itemId, local, deviceId }) => {
        const existingClock = (local.clock as VectorClock) ?? {}
        const newClock = incrementClock(existingClock, deviceId)

        deps.db
          .update(taskActivity)
          .set({ clock: newClock })
          .where(eq(taskActivity.id, itemId))
          .run()

        return { ...local, clock: newClock }
      },
      serialize: (local) => local,
      buildDeletePayload: ({ extra }) => extra[0]
    })
  }

  enqueueCreate(activityId: string): void {
    this.controller.enqueueCreate(activityId)
  }

  enqueueUpdate(): void {
    // No-op: rows are immutable. Present because RecordLocalSyncAdapter requires it.
  }

  enqueueDelete(): void {
    // No-op: retention prunes locally on every device from the same age rule.
  }
}
