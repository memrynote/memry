import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import type * as schema from '@shared/db/schema/data-schema'
import { projects } from '@shared/db/schema/projects'
import { statuses } from '@shared/db/schema/statuses'
import type { VectorClock } from '@shared/contracts/sync-api'
import type { SyncQueueManager } from './queue'
import { increment } from './vector-clock'
import { type FieldClocks, initAllFieldClocks, PROJECT_SYNCABLE_FIELDS } from './field-merge'
import {
  hasOfflineClockData,
  incrementProjectClocksOffline,
  rebindOfflineClockData
} from './offline-clock'
import { createLogger } from '../lib/logger'

type DrizzleDb = BetterSQLite3Database<typeof schema>

const log = createLogger('ProjectSync')

interface ProjectSyncDeps {
  queue: SyncQueueManager
  db: DrizzleDb
  getDeviceId: () => string | null
}

let instance: ProjectSyncService | null = null

export function initProjectSyncService(deps: ProjectSyncDeps): ProjectSyncService {
  instance = new ProjectSyncService(deps)
  return instance
}

export function getProjectSyncService(): ProjectSyncService | null {
  return instance
}

export function resetProjectSyncService(): void {
  instance = null
}

export class ProjectSyncService {
  private queue: SyncQueueManager
  private db: DrizzleDb
  private getDeviceId: () => string | null

  constructor(deps: ProjectSyncDeps) {
    this.queue = deps.queue
    this.db = deps.db
    this.getDeviceId = deps.getDeviceId
  }

  enqueueCreate(projectId: string): void {
    this.enqueue(projectId, 'create')
  }

  enqueueUpdate(projectId: string, changedFields?: string[]): void {
    this.enqueue(projectId, 'update', changedFields)
  }

  enqueueForPush(projectId: string, operation: 'create' | 'update'): void {
    try {
      const project = this.db.select().from(projects).where(eq(projects.id, projectId)).get()
      if (!project) {
        log.warn('Project not found for re-enqueue', { projectId })
        return
      }

      const projectStatuses = this.db
        .select()
        .from(statuses)
        .where(eq(statuses.projectId, projectId))
        .all()

      this.queue.enqueue({
        type: 'project',
        itemId: projectId,
        operation,
        payload: JSON.stringify({ ...project, statuses: projectStatuses }),
        priority: 0
      })
    } catch (err) {
      log.error('Failed to re-enqueue project for push', err)
    }
  }

  enqueueRecoveredUpdate(projectId: string): void {
    const deviceId = this.getDeviceId()
    if (!deviceId) {
      log.warn('No device ID available, skipping recovered project enqueue')
      return
    }

    try {
      const project = this.db.select().from(projects).where(eq(projects.id, projectId)).get()
      if (!project) {
        log.warn('Project not found for recovered enqueue', { projectId })
        return
      }

      const projectStatuses = this.db
        .select()
        .from(statuses)
        .where(eq(statuses.projectId, projectId))
        .all()

      const existingClock = (project.clock as VectorClock) ?? {}
      const existingFieldClocks = (project.fieldClocks as FieldClocks | null) ?? null

      if (!hasOfflineClockData(existingClock, existingFieldClocks)) {
        // No offline marker: local clocks were already advanced when the change was made.
        this.enqueueForPush(projectId, 'update')
        return
      }

      const rebased = rebindOfflineClockData(
        existingClock,
        existingFieldClocks,
        deviceId,
        PROJECT_SYNCABLE_FIELDS
      )

      this.db
        .update(projects)
        .set({ clock: rebased.clock, fieldClocks: rebased.fieldClocks })
        .where(eq(projects.id, projectId))
        .run()

      this.queue.enqueue({
        type: 'project',
        itemId: projectId,
        operation: 'update',
        payload: JSON.stringify({
          ...project,
          clock: rebased.clock,
          fieldClocks: rebased.fieldClocks,
          statuses: projectStatuses
        }),
        priority: 0
      })
    } catch (err) {
      log.error('Failed to enqueue recovered project update', err)
    }
  }

  enqueueDelete(projectId: string, snapshotPayload: string): void {
    const deviceId = this.getDeviceId()
    if (!deviceId) {
      log.warn('No device ID available, skipping sync enqueue for delete')
      return
    }

    try {
      const payload = this.withIncrementedClock(snapshotPayload, deviceId)
      this.queue.enqueue({
        type: 'project',
        itemId: projectId,
        operation: 'delete',
        payload,
        priority: 0
      })
    } catch (err) {
      log.error('Failed to enqueue project delete', err)
    }
  }

  private enqueue(
    projectId: string,
    operation: 'create' | 'update',
    changedFields?: string[]
  ): void {
    const deviceId = this.getDeviceId()
    if (!deviceId) {
      log.warn('No device ID available, tracking project change with offline clock', {
        projectId,
        operation
      })
      if (operation === 'create') {
        incrementProjectClocksOffline(this.db, projectId)
      } else {
        incrementProjectClocksOffline(
          this.db,
          projectId,
          changedFields ?? [...PROJECT_SYNCABLE_FIELDS]
        )
      }
      return
    }

    try {
      const project = this.db.select().from(projects).where(eq(projects.id, projectId)).get()
      if (!project) {
        log.warn('Project not found for sync enqueue', { projectId })
        return
      }

      const projectStatuses = this.db
        .select()
        .from(statuses)
        .where(eq(statuses.projectId, projectId))
        .all()

      const existingClock = (project.clock as VectorClock) ?? {}
      const newClock = increment(existingClock, deviceId)

      let fieldClocks = (project.fieldClocks as FieldClocks) ?? null
      if (!fieldClocks) {
        fieldClocks = initAllFieldClocks(existingClock, PROJECT_SYNCABLE_FIELDS)
      }

      const fieldsToIncrement =
        operation === 'create' ? PROJECT_SYNCABLE_FIELDS : (changedFields ?? PROJECT_SYNCABLE_FIELDS)
      const updatedFieldClocks = { ...fieldClocks }
      for (const field of fieldsToIncrement) {
        updatedFieldClocks[field] = increment(updatedFieldClocks[field] ?? {}, deviceId)
      }

      this.db
        .update(projects)
        .set({ clock: newClock, fieldClocks: updatedFieldClocks })
        .where(eq(projects.id, projectId))
        .run()

      const payload = JSON.stringify({
        ...project,
        clock: newClock,
        fieldClocks: updatedFieldClocks,
        statuses: projectStatuses
      })

      this.queue.enqueue({
        type: 'project',
        itemId: projectId,
        operation,
        payload,
        priority: 0
      })
    } catch (err) {
      log.error(`Failed to enqueue project ${operation}`, err)
    }
  }

  private withIncrementedClock(payload: string, deviceId: string): string {
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>
      const existingClock =
        parsed.clock && typeof parsed.clock === 'object' && !Array.isArray(parsed.clock)
          ? (parsed.clock as VectorClock)
          : {}
      const newClock = increment(existingClock, deviceId)
      return JSON.stringify({ ...parsed, clock: newClock })
    } catch {
      return payload
    }
  }
}
