import { eq } from 'drizzle-orm'
import { projects } from '@memry/db-schema/schema/projects'
import { statuses } from '@memry/db-schema/schema/statuses'
import type { VectorClock } from '@memry/contracts/sync-api'
import { RecordSyncController, incrementClock, withIncrementedClock } from '@memry/sync-core'
import type { SyncQueueManager } from './queue'
import { type FieldClocks, initAllFieldClocks, PROJECT_SYNCABLE_FIELDS } from './field-merge'
import {
  hasOfflineClockData,
  incrementProjectClocksOffline,
  rebindOfflineClockData
} from './offline-clock'
import { createLogger } from '../lib/logger'
import type { DrizzleDb } from '../database/client'

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
  private controller: RecordSyncController<Record<string, unknown>, [string[]?], [string]>

  constructor(deps: ProjectSyncDeps) {
    this.controller = new RecordSyncController({
      type: 'project',
      queue: deps.queue,
      getDeviceId: deps.getDeviceId,
      load: (projectId) =>
        deps.db.select().from(projects).where(eq(projects.id, projectId)).get() as
          | Record<string, unknown>
          | undefined,
      applyLocalChange: ({ itemId, local, deviceId, operation, extra }) => {
        const changedFields = extra[0]
        const existingClock = (local.clock as VectorClock) ?? {}
        const newClock = incrementClock(existingClock, deviceId)

        let fieldClocks = (local.fieldClocks as FieldClocks) ?? null
        if (!fieldClocks) {
          fieldClocks = initAllFieldClocks(existingClock, PROJECT_SYNCABLE_FIELDS)
        }

        const fieldsToIncrement =
          operation === 'create'
            ? PROJECT_SYNCABLE_FIELDS
            : (changedFields ?? PROJECT_SYNCABLE_FIELDS)
        const updatedFieldClocks = { ...fieldClocks }
        for (const field of fieldsToIncrement) {
          updatedFieldClocks[field] = incrementClock(updatedFieldClocks[field] ?? {}, deviceId)
        }

        deps.db
          .update(projects)
          .set({ clock: newClock, fieldClocks: updatedFieldClocks })
          .where(eq(projects.id, itemId))
          .run()

        const projectStatuses = deps.db
          .select()
          .from(statuses)
          .where(eq(statuses.projectId, itemId))
          .all()

        return {
          ...local,
          clock: newClock,
          fieldClocks: updatedFieldClocks,
          statuses: projectStatuses
        }
      },
      serialize: (local) => local,
      handleMissingDevice: (projectId, operation, extra) => {
        const changedFields = extra[0]
        log.warn('No device ID available, tracking project change with offline clock', {
          projectId,
          operation
        })
        if (operation === 'create') {
          incrementProjectClocksOffline(deps.db, projectId)
        } else {
          incrementProjectClocksOffline(
            deps.db,
            projectId,
            changedFields ?? [...PROJECT_SYNCABLE_FIELDS]
          )
        }
      },
      buildDeletePayload: ({ extra, deviceId }) => withIncrementedClock(extra[0], deviceId),
      buildFreshPayload: (projectId) => {
        const project = deps.db.select().from(projects).where(eq(projects.id, projectId)).get()
        if (!project) {
          log.warn('Project not found for re-enqueue', { projectId })
          return null
        }

        const projectStatuses = deps.db
          .select()
          .from(statuses)
          .where(eq(statuses.projectId, projectId))
          .all()

        return JSON.stringify({ ...project, statuses: projectStatuses })
      },
      recoverPendingChange: (projectId, deviceId) => {
        const project = deps.db.select().from(projects).where(eq(projects.id, projectId)).get()
        if (!project) {
          log.warn('Project not found for recovered enqueue', { projectId })
          return null
        }

        const existingClock = (project.clock as VectorClock) ?? {}
        const existingFieldClocks = project.fieldClocks ?? null

        if (!hasOfflineClockData(existingClock, existingFieldClocks)) {
          return null
        }

        const rebased = rebindOfflineClockData(
          existingClock,
          existingFieldClocks,
          deviceId,
          PROJECT_SYNCABLE_FIELDS
        )

        deps.db
          .update(projects)
          .set({ clock: rebased.clock, fieldClocks: rebased.fieldClocks })
          .where(eq(projects.id, projectId))
          .run()

        const projectStatuses = deps.db
          .select()
          .from(statuses)
          .where(eq(statuses.projectId, projectId))
          .all()

        return {
          ...project,
          clock: rebased.clock,
          fieldClocks: rebased.fieldClocks,
          statuses: projectStatuses
        }
      },
      serializeRecovered: (local) => local
    })
  }

  enqueueCreate(projectId: string): void {
    this.controller.enqueueCreate(projectId)
  }

  enqueueUpdate(projectId: string, changedFields?: string[]): void {
    this.controller.enqueueUpdate(projectId, changedFields)
  }

  enqueueForPush(projectId: string, operation: 'create' | 'update'): void {
    this.controller.enqueueForPush(projectId, operation)
  }

  enqueueRecoveredUpdate(projectId: string): void {
    this.controller.enqueueRecoveredUpdate(projectId)
  }

  enqueueDelete(projectId: string, snapshotPayload: string): void {
    this.controller.enqueueDelete(projectId, snapshotPayload)
  }
}
