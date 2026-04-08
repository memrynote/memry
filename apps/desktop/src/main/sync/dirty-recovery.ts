import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { and, gt, isNull, isNotNull, or } from 'drizzle-orm'
import type * as schema from '@memry/db-schema/data-schema'
import type { SyncAdapterRegistry } from '@memry/sync-core'
import { tasks } from '@memry/db-schema/schema/tasks'
import { projects } from '@memry/db-schema/schema/projects'
import { getProjectSyncService } from './project-sync'
import { getTaskSyncService } from './task-sync'
import { createLogger } from '../lib/logger'

type DrizzleDb = BetterSQLite3Database<typeof schema>

const log = createLogger('DirtyRecovery')

export interface RecoveryResult {
  tasks: number
  projects: number
}

/**
 * Scans for locally-modified items that were never synced (e.g. edited while signed out).
 * Re-enqueues them for the next sync cycle, rebinding offline placeholder clocks when present.
 *
 * Detection: modifiedAt > syncedAt (modified since last sync) OR syncedAt IS NULL (never synced).
 * Safe to call multiple times — SyncQueueManager.enqueue() deduplicates by itemId+type+operation.
 */
export function recoverDirtyItems(
  db: DrizzleDb,
  adapters?: SyncAdapterRegistry<DrizzleDb, (channel: string, data: unknown) => void>
): RecoveryResult {
  const taskSync = adapters?.getLocal('task') ?? getTaskSyncService()
  const projectSync = adapters?.getLocal('project') ?? getProjectSyncService()

  let taskCount = 0
  let projectCount = 0

  if (taskSync) {
    const dirtyTasks = db
      .select({ id: tasks.id, syncedAt: tasks.syncedAt })
      .from(tasks)
      .where(
        or(
          and(isNotNull(tasks.syncedAt), gt(tasks.modifiedAt, tasks.syncedAt)),
          isNull(tasks.syncedAt)
        )
      )
      .all()

    for (const t of dirtyTasks) {
      const op = t.syncedAt ? 'update' : 'create'
      log.debug('Recovering dirty task', { taskId: t.id, op, syncedAt: t.syncedAt })
      if (t.syncedAt) {
        if (taskSync.enqueueRecoveredUpdate) {
          taskSync.enqueueRecoveredUpdate(t.id)
        } else {
          taskSync.enqueueUpdate(t.id)
        }
      } else {
        taskSync.enqueueCreate(t.id)
      }
      taskCount++
    }
  }

  if (projectSync) {
    const dirtyProjects = db
      .select({ id: projects.id, syncedAt: projects.syncedAt })
      .from(projects)
      .where(
        or(
          and(isNotNull(projects.syncedAt), gt(projects.modifiedAt, projects.syncedAt)),
          isNull(projects.syncedAt)
        )
      )
      .all()

    for (const p of dirtyProjects) {
      log.debug('Recovering dirty project', { projectId: p.id, syncedAt: p.syncedAt })
      if (p.syncedAt) {
        if (projectSync.enqueueRecoveredUpdate) {
          projectSync.enqueueRecoveredUpdate(p.id)
        } else {
          projectSync.enqueueUpdate(p.id)
        }
      } else {
        projectSync.enqueueCreate(p.id)
      }
      projectCount++
    }
  }

  if (taskCount > 0 || projectCount > 0) {
    log.info('Recovered dirty items for sync', { tasks: taskCount, projects: projectCount })
  }

  return { tasks: taskCount, projects: projectCount }
}
