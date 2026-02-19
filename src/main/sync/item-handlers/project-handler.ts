import { eq, isNull, and, notInArray } from 'drizzle-orm'
import { projects } from '@shared/db/schema/projects'
import { statuses } from '@shared/db/schema/statuses'
import {
  ProjectSyncPayloadSchema,
  type ProjectSyncPayload,
  type StatusSync
} from '@shared/contracts/sync-payloads'
import { TasksChannels } from '@shared/ipc-channels'
import type { VectorClock } from '@shared/contracts/sync-api'
import type { SyncQueueManager } from '../queue'
import { increment } from '../vector-clock'
import { createLogger } from '../../lib/logger'
import { resolveClockConflict } from './types'
import type { SyncItemHandler, ApplyContext, ApplyResult, DrizzleDb } from './types'

const log = createLogger('ProjectHandler')

function reconcileStatuses(tx: DrizzleDb, projectId: string, incoming: StatusSync[]): void {
  const incomingIds = incoming.map((s) => s.id)

  if (incomingIds.length > 0) {
    tx.delete(statuses)
      .where(and(eq(statuses.projectId, projectId), notInArray(statuses.id, incomingIds)))
      .run()
  } else {
    tx.delete(statuses).where(eq(statuses.projectId, projectId)).run()
  }

  for (const s of incoming) {
    const existing = tx.select().from(statuses).where(eq(statuses.id, s.id)).get()
    if (existing) {
      tx.update(statuses)
        .set({
          name: s.name,
          color: s.color,
          position: s.position,
          isDefault: s.isDefault ?? false,
          isDone: s.isDone ?? false
        })
        .where(eq(statuses.id, s.id))
        .run()
    } else {
      tx.insert(statuses)
        .values({
          id: s.id,
          projectId,
          name: s.name,
          color: s.color,
          position: s.position,
          isDefault: s.isDefault ?? false,
          isDone: s.isDone ?? false,
          createdAt: s.createdAt ?? new Date().toISOString()
        })
        .run()
    }
  }
}

export const projectHandler: SyncItemHandler<ProjectSyncPayload> = {
  type: 'project',
  schema: ProjectSyncPayloadSchema,

  applyUpsert(
    ctx: ApplyContext,
    itemId: string,
    data: ProjectSyncPayload,
    clock: VectorClock
  ): ApplyResult {
    return ctx.db.transaction((tx): ApplyResult => {
      const existing = tx.select().from(projects).where(eq(projects.id, itemId)).get()
      const remoteClock = Object.keys(clock).length > 0 ? clock : (data.clock ?? {})
      const now = new Date().toISOString()

      if (data.isInbox && !existing) {
        const localInbox = tx.select().from(projects).where(eq(projects.isInbox, true)).get()
        if (localInbox && localInbox.id !== itemId) {
          log.info('Skipping remote inbox project, local inbox already exists', {
            remoteId: itemId,
            localId: localInbox.id
          })
          return 'skipped'
        }
      }

      if (existing) {
        const resolution = resolveClockConflict(existing.clock, remoteClock)
        if (resolution.action === 'skip') {
          log.info('Skipping remote project update, local is newer', { itemId })
          return 'skipped'
        }
        if (resolution.action === 'merge') {
          log.warn('Concurrent project edit, using last-write-wins', { itemId })
        }

        tx.update(projects)
          .set({
            name: data.name ?? existing.name,
            description: data.description ?? null,
            color: data.color ?? existing.color,
            icon: data.icon ?? null,
            position: data.position ?? existing.position,
            isInbox: data.isInbox ?? existing.isInbox,
            archivedAt: data.archivedAt ?? null,
            clock: resolution.mergedClock,
            syncedAt: now,
            modifiedAt: data.modifiedAt ?? now
          })
          .where(eq(projects.id, itemId))
          .run()

        if (data.statuses) {
          reconcileStatuses(tx as unknown as DrizzleDb, itemId, data.statuses)
        }

        const updated = tx.select().from(projects).where(eq(projects.id, itemId)).get()
        const updatedStatuses = tx
          .select()
          .from(statuses)
          .where(eq(statuses.projectId, itemId))
          .all()
        ctx.emit(TasksChannels.events.PROJECT_UPDATED, {
          id: itemId,
          project: updated ? { ...updated, statuses: updatedStatuses } : updated
        })
        return resolution.action === 'merge' ? 'conflict' : 'applied'
      }

      tx.insert(projects)
        .values({
          id: itemId,
          name: data.name ?? 'Untitled',
          description: data.description ?? null,
          color: data.color ?? '#6366f1',
          icon: data.icon ?? null,
          position: data.position ?? 0,
          isInbox: data.isInbox ?? false,
          archivedAt: data.archivedAt ?? null,
          clock: remoteClock,
          syncedAt: now,
          createdAt: data.createdAt ?? now,
          modifiedAt: data.modifiedAt ?? now
        })
        .run()

      if (data.statuses) {
        reconcileStatuses(tx as unknown as DrizzleDb, itemId, data.statuses)
      }

      const inserted = tx.select().from(projects).where(eq(projects.id, itemId)).get()
      const insertedStatuses = tx
        .select()
        .from(statuses)
        .where(eq(statuses.projectId, itemId))
        .all()
      ctx.emit(TasksChannels.events.PROJECT_CREATED, {
        project: inserted ? { ...inserted, statuses: insertedStatuses } : inserted
      })
      return 'applied'
    })
  },

  applyDelete(ctx: ApplyContext, itemId: string, clock?: VectorClock): 'applied' | 'skipped' {
    const existing = ctx.db.select().from(projects).where(eq(projects.id, itemId)).get()
    if (!existing) return 'skipped'

    if (existing.isInbox) {
      log.info('Refusing to delete inbox project via sync', { itemId })
      return 'skipped'
    }

    if (clock && existing.clock) {
      const resolution = resolveClockConflict(existing.clock, clock)
      if (resolution.action === 'skip' || resolution.action === 'merge') {
        log.info('Skipping remote project delete, local has unseen changes', { itemId })
        return 'skipped'
      }
    }

    ctx.db.delete(projects).where(eq(projects.id, itemId)).run()
    ctx.emit(TasksChannels.events.PROJECT_DELETED, { id: itemId })
    return 'applied'
  },

  fetchLocal(db: DrizzleDb, itemId: string): Record<string, unknown> | undefined {
    const project = db.select().from(projects).where(eq(projects.id, itemId)).get()
    if (!project) return undefined

    const projectStatuses = db.select().from(statuses).where(eq(statuses.projectId, itemId)).all()

    return { ...project, statuses: projectStatuses } as Record<string, unknown>
  },

  buildPushPayload(db: DrizzleDb, itemId: string, _deviceId: string, _operation: string): string | null {
    const project = db.select().from(projects).where(eq(projects.id, itemId)).get()
    if (!project) return null

    const projectStatuses = db.select().from(statuses).where(eq(statuses.projectId, itemId)).all()

    return JSON.stringify({ ...project, statuses: projectStatuses })
  },

  seedUnclocked(db: DrizzleDb, deviceId: string, queue: SyncQueueManager): number {
    const items = db.select().from(projects).where(isNull(projects.clock)).all()
    for (const item of items) {
      const clock = increment({}, deviceId)
      db.update(projects).set({ clock }).where(eq(projects.id, item.id)).run()

      const projectStatuses = db
        .select()
        .from(statuses)
        .where(eq(statuses.projectId, item.id))
        .all()

      queue.enqueue({
        type: 'project',
        itemId: item.id,
        operation: 'create',
        payload: JSON.stringify({ ...item, clock, statuses: projectStatuses }),
        priority: 0
      })
    }
    return items.length
  }
}
