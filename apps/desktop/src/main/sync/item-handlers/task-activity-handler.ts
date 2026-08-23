import { eq, isNull } from 'drizzle-orm'
import { taskActivity } from '@memry/db-schema/schema/task-activity'
import {
  TaskActivitySyncPayloadSchema,
  type TaskActivitySyncPayload
} from '@memry/contracts/sync-payloads'
import { TaskActivityChannels } from '@memry/contracts/ipc-channels'
import type { VectorClock } from '@memry/contracts/sync-api'
import { utcNow } from '@memry/shared/utc'
import type { SyncQueueManager } from '../queue'
import { increment } from '@memry/sync-client/vector-clock'
import { createLogger } from '../../lib/logger'
import { isBeyondTaskActivityRetention } from '@memry/sync-client/task-activity-retention'
import { BaseItemHandler } from './base-handler'
import type { ApplyContext, ApplyResult, DrizzleDb } from './types'

const log = createLogger('TaskActivityHandler')

/**
 * Activity rows are append-only.
 *
 * `applyUpsert` is therefore insert-if-absent and never an update — an id that
 * is already present returns `'skipped'`, which is what makes immutable rows
 * safe under whole-row LWW. It is also what collapses the two mirror-image
 * `superseded` rows both sides of a conflict write: they derive the same
 * deterministic id, so the second one to arrive is a no-op.
 */
class TaskActivityHandler extends BaseItemHandler<TaskActivitySyncPayload> {
  readonly type = 'task_activity' as const
  readonly schema = TaskActivitySyncPayloadSchema

  applyUpsert(
    ctx: ApplyContext,
    itemId: string,
    data: TaskActivitySyncPayload,
    clock: VectorClock
  ): ApplyResult {
    if (!data.taskId || !data.action) {
      log.warn('Dropping task activity row with no taskId/action', { itemId })
      return 'skipped'
    }

    const createdAt = data.createdAt ?? utcNow()

    // Retention is enforced here, not only where rows are written. A row this
    // device already pruned would otherwise be resurrected by any peer that
    // still holds it.
    if (isBeyondTaskActivityRetention(createdAt)) {
      log.debug('Skipping task activity row past retention cutoff', { itemId, createdAt })
      return 'skipped'
    }

    return ctx.db.transaction((tx): ApplyResult => {
      const existing = tx.select().from(taskActivity).where(eq(taskActivity.id, itemId)).get()
      if (existing) return 'skipped'

      const remoteClock = Object.keys(clock).length > 0 ? clock : (data.clock ?? {})

      tx.insert(taskActivity)
        .values({
          id: itemId,
          taskId: data.taskId as string,
          action: data.action as string,
          field: data.field ?? null,
          oldValue: data.oldValue ?? null,
          newValue: data.newValue ?? null,
          actor: data.actor ?? 'user',
          deviceId: data.deviceId ?? null,
          createdAt,
          clock: remoteClock,
          syncedAt: utcNow()
        })
        .run()

      ctx.emit(TaskActivityChannels.events.CREATED, { id: itemId, taskId: data.taskId })
      return 'applied'
    })
  }

  applyDelete(ctx: ApplyContext, itemId: string): 'applied' | 'skipped' {
    const existing = ctx.db.select().from(taskActivity).where(eq(taskActivity.id, itemId)).get()
    if (!existing) return 'skipped'

    // No clock comparison: the row is immutable, so there are never local
    // changes a remote delete could be losing to.
    ctx.db.delete(taskActivity).where(eq(taskActivity.id, itemId)).run()
    ctx.emit(TaskActivityChannels.events.DELETED, { id: itemId, taskId: existing.taskId })
    return 'applied'
  }

  fetchLocal(db: DrizzleDb, itemId: string): Record<string, unknown> | undefined {
    return db.select().from(taskActivity).where(eq(taskActivity.id, itemId)).get() as
      Record<string, unknown> | undefined
  }

  buildPushPayload(
    db: DrizzleDb,
    itemId: string,
    _deviceId: string,
    _operation: string
  ): string | null {
    const row = db.select().from(taskActivity).where(eq(taskActivity.id, itemId)).get()
    if (!row) return null
    return JSON.stringify(row)
  }

  markPushSynced(db: DrizzleDb, itemId: string): void {
    db.update(taskActivity).set({ syncedAt: utcNow() }).where(eq(taskActivity.id, itemId)).run()
  }

  seedUnclocked(db: DrizzleDb, deviceId: string, queue: SyncQueueManager): number {
    const rows = db.select().from(taskActivity).where(isNull(taskActivity.clock)).all()
    let seeded = 0
    for (const row of rows) {
      // Same cutoff as apply — seeding an expired row would push it back out to
      // peers that had already pruned it.
      if (isBeyondTaskActivityRetention(row.createdAt)) continue

      const clock = increment({}, deviceId)
      db.update(taskActivity).set({ clock }).where(eq(taskActivity.id, row.id)).run()
      queue.enqueue({
        type: 'task_activity',
        itemId: row.id,
        operation: 'create',
        payload: JSON.stringify({ ...row, clock }),
        priority: 0
      })
      seeded++
    }
    return seeded
  }
}

export const taskActivityHandler = new TaskActivityHandler()
