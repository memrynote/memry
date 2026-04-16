import { eq, isNull, and, notInArray } from 'drizzle-orm'
import { projects } from '@memry/db-schema/schema/projects'
import { statuses } from '@memry/db-schema/schema/statuses'
import { utcNow } from '@memry/shared/utc'
import {
  ProjectSyncPayloadSchema,
  type ProjectSyncPayload,
  type StatusSync
} from '@memry/contracts/sync-payloads'
import { TasksChannels } from '@memry/contracts/ipc-channels'
import type { VectorClock } from '@memry/contracts/sync-api'
import type { SyncQueueManager } from '../queue'
import { increment } from '../vector-clock'
import { mergeProjectFields, initAllFieldClocks, PROJECT_SYNCABLE_FIELDS } from '../field-merge'
import { createLogger } from '../../lib/logger'
import { BaseItemHandler } from './base-handler'
import type { ApplyContext, ApplyResult, DrizzleDb } from './types'

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
          createdAt: s.createdAt ?? utcNow()
        })
        .run()
    }
  }
}

class ProjectHandler extends BaseItemHandler<ProjectSyncPayload> {
  readonly type = 'project' as const
  readonly schema = ProjectSyncPayloadSchema

  applyUpsert(
    ctx: ApplyContext,
    itemId: string,
    data: ProjectSyncPayload,
    clock: VectorClock
  ): ApplyResult {
    return ctx.db.transaction((tx): ApplyResult => {
      const existing = tx.select().from(projects).where(eq(projects.id, itemId)).get()
      const remoteClock = Object.keys(clock).length > 0 ? clock : (data.clock ?? {})
      const now = utcNow()

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
        const resolution = this.resolveClock(existing.clock, remoteClock)
        if (resolution.action === 'skip') {
          log.info('Skipping remote project update, local is newer', { itemId })
          return 'skipped'
        }

        if (resolution.action === 'merge') {
          log.warn('Concurrent project edit, using field-level merge', { itemId })
          const localFC =
            existing.fieldClocks ??
            initAllFieldClocks(existing.clock ?? {}, PROJECT_SYNCABLE_FIELDS)
          const remoteFC =
            data.fieldClocks ?? initAllFieldClocks(remoteClock, PROJECT_SYNCABLE_FIELDS)
          const mergeResult = mergeProjectFields(
            existing as unknown as Record<string, unknown>,
            data as unknown as Record<string, unknown>,
            localFC,
            remoteFC
          )

          tx.update(projects)
            .set({
              name: (mergeResult.merged.name as string) ?? existing.name,
              description: (mergeResult.merged.description as string | null) ?? null,
              color: (mergeResult.merged.color as string) ?? existing.color,
              icon: (mergeResult.merged.icon as string | null) ?? null,
              position: (mergeResult.merged.position as number) ?? existing.position,
              isInbox: (mergeResult.merged.isInbox as boolean) ?? existing.isInbox,
              archivedAt: (mergeResult.merged.archivedAt as string | null) ?? null,
              clock: resolution.mergedClock,
              fieldClocks: mergeResult.mergedFieldClocks,
              syncedAt: now,
              modifiedAt: (mergeResult.merged.modifiedAt as string) ?? now
            })
            .where(eq(projects.id, itemId))
            .run()
        } else {
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
              fieldClocks: data.fieldClocks ?? existing.fieldClocks ?? null,
              syncedAt: now,
              modifiedAt: data.modifiedAt ?? now
            })
            .where(eq(projects.id, itemId))
            .run()
        }

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
          fieldClocks: data.fieldClocks ?? null,
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
  }

  applyDelete(ctx: ApplyContext, itemId: string, clock?: VectorClock): 'applied' | 'skipped' {
    const existing = ctx.db.select().from(projects).where(eq(projects.id, itemId)).get()
    if (!existing) return 'skipped'

    if (existing.isInbox) {
      log.info('Refusing to delete inbox project via sync', { itemId })
      return 'skipped'
    }

    if (clock && existing.clock) {
      const resolution = this.resolveClock(existing.clock, clock)
      if (resolution.action === 'skip' || resolution.action === 'merge') {
        log.info('Skipping remote project delete, local has unseen changes', { itemId })
        return 'skipped'
      }
    }

    ctx.db.delete(projects).where(eq(projects.id, itemId)).run()
    ctx.emit(TasksChannels.events.PROJECT_DELETED, { id: itemId })
    return 'applied'
  }

  fetchLocal(db: DrizzleDb, itemId: string): Record<string, unknown> | undefined {
    const project = db.select().from(projects).where(eq(projects.id, itemId)).get()
    if (!project) return undefined

    const projectStatuses = db.select().from(statuses).where(eq(statuses.projectId, itemId)).all()

    return { ...project, statuses: projectStatuses } as Record<string, unknown>
  }

  buildPushPayload(
    db: DrizzleDb,
    itemId: string,
    _deviceId: string,
    _operation: string
  ): string | null {
    const project = db.select().from(projects).where(eq(projects.id, itemId)).get()
    if (!project) return null

    const projectStatuses = db.select().from(statuses).where(eq(statuses.projectId, itemId)).all()

    return JSON.stringify({ ...project, statuses: projectStatuses })
  }

  markPushSynced(db: DrizzleDb, itemId: string): void {
    db.update(projects).set({ syncedAt: utcNow() }).where(eq(projects.id, itemId)).run()
  }

  seedUnclocked(db: DrizzleDb, deviceId: string, queue: SyncQueueManager): number {
    const items = db.select().from(projects).where(isNull(projects.clock)).all()
    for (const item of items) {
      const clock = increment({}, deviceId)
      const fieldClocks = initAllFieldClocks(clock, PROJECT_SYNCABLE_FIELDS)
      db.update(projects).set({ clock, fieldClocks }).where(eq(projects.id, item.id)).run()

      const projectStatuses = db
        .select()
        .from(statuses)
        .where(eq(statuses.projectId, item.id))
        .all()

      queue.enqueue({
        type: 'project',
        itemId: item.id,
        operation: 'create',
        payload: JSON.stringify({ ...item, clock, fieldClocks, statuses: projectStatuses }),
        priority: 0
      })
    }
    return items.length
  }
}

export const projectHandler = new ProjectHandler()
