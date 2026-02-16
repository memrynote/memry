import { eq, isNull } from 'drizzle-orm'
import { tasks } from '@shared/db/schema/tasks'
import { TaskSyncPayloadSchema, type TaskSyncPayload } from '@shared/contracts/sync-payloads'
import { TasksChannels } from '@shared/ipc-channels'
import type { VectorClock } from '@shared/contracts/sync-api'
import type { SyncQueueManager } from '../queue'
import { increment } from '../vector-clock'
import { createLogger } from '../../lib/logger'
import { resolveClockConflict } from './types'
import type { SyncItemHandler, ApplyContext, ApplyResult, DrizzleDb } from './types'

const log = createLogger('TaskHandler')

export const taskHandler: SyncItemHandler<TaskSyncPayload> = {
  type: 'task',
  schema: TaskSyncPayloadSchema,

  applyUpsert(
    ctx: ApplyContext,
    itemId: string,
    data: TaskSyncPayload,
    clock: VectorClock
  ): ApplyResult {
    return ctx.db.transaction((tx): ApplyResult => {
      const existing = tx.select().from(tasks).where(eq(tasks.id, itemId)).get()
      const remoteClock = Object.keys(clock).length > 0 ? clock : (data.clock ?? {})
      const now = new Date().toISOString()

      if (existing) {
        const resolution = resolveClockConflict(existing.clock, remoteClock)
        if (resolution.action === 'skip') {
          log.info('Skipping remote task update, local is newer', { itemId })
          return 'skipped'
        }
        if (resolution.action === 'merge') {
          log.warn('Concurrent task edit, using last-write-wins', { itemId })
        }

        tx.update(tasks)
          .set({
            title: data.title,
            description: data.description ?? null,
            projectId: data.projectId,
            statusId: data.statusId ?? null,
            parentId: data.parentId ?? null,
            priority: data.priority ?? 0,
            position: data.position ?? 0,
            dueDate: data.dueDate ?? null,
            dueTime: data.dueTime ?? null,
            startDate: data.startDate ?? null,
            repeatConfig: data.repeatConfig ?? null,
            repeatFrom: data.repeatFrom ?? null,
            sourceNoteId: data.sourceNoteId ?? null,
            completedAt: data.completedAt ?? null,
            archivedAt: data.archivedAt ?? null,
            clock: resolution.mergedClock,
            syncedAt: now,
            modifiedAt: data.modifiedAt ?? now
          })
          .where(eq(tasks.id, itemId))
          .run()

        const updated = tx.select().from(tasks).where(eq(tasks.id, itemId)).get()
        ctx.emit(TasksChannels.events.UPDATED, { id: itemId, task: updated, changes: {} })
        return resolution.action === 'merge' ? 'conflict' : 'applied'
      }

      tx.insert(tasks)
        .values({
          id: itemId,
          title: data.title ?? 'Untitled',
          projectId: data.projectId,
          statusId: data.statusId ?? null,
          parentId: data.parentId ?? null,
          description: data.description ?? null,
          priority: data.priority ?? 0,
          position: data.position ?? 0,
          dueDate: data.dueDate ?? null,
          dueTime: data.dueTime ?? null,
          startDate: data.startDate ?? null,
          repeatConfig: data.repeatConfig ?? null,
          repeatFrom: data.repeatFrom ?? null,
          sourceNoteId: data.sourceNoteId ?? null,
          completedAt: data.completedAt ?? null,
          archivedAt: data.archivedAt ?? null,
          clock: remoteClock,
          syncedAt: now,
          createdAt: data.createdAt ?? now,
          modifiedAt: data.modifiedAt ?? now
        })
        .run()

      const inserted = tx.select().from(tasks).where(eq(tasks.id, itemId)).get()
      ctx.emit(TasksChannels.events.CREATED, { task: inserted })
      return 'applied'
    })
  },

  applyDelete(ctx: ApplyContext, itemId: string, clock?: VectorClock): 'applied' | 'skipped' {
    const existing = ctx.db.select().from(tasks).where(eq(tasks.id, itemId)).get()
    if (!existing) return 'skipped'

    if (clock && existing.clock) {
      const resolution = resolveClockConflict(existing.clock, clock)
      if (resolution.action === 'skip' || resolution.action === 'merge') {
        log.info('Skipping remote task delete, local has unseen changes', { itemId })
        return 'skipped'
      }
    }

    ctx.db.delete(tasks).where(eq(tasks.id, itemId)).run()
    ctx.emit(TasksChannels.events.DELETED, { id: itemId })
    return 'applied'
  },

  fetchLocal(db: DrizzleDb, itemId: string): Record<string, unknown> | undefined {
    return db.select().from(tasks).where(eq(tasks.id, itemId)).get() as
      | Record<string, unknown>
      | undefined
  },

  seedUnclocked(db: DrizzleDb, deviceId: string, queue: SyncQueueManager): number {
    const items = db.select().from(tasks).where(isNull(tasks.clock)).all()
    for (const item of items) {
      const clock = increment({}, deviceId)
      db.update(tasks).set({ clock }).where(eq(tasks.id, item.id)).run()
      queue.enqueue({
        type: 'task',
        itemId: item.id,
        operation: 'create',
        payload: JSON.stringify({ ...item, clock }),
        priority: 0
      })
    }
    return items.length
  }
}
