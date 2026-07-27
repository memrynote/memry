import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { and, gt, isNull, isNotNull, or, sql } from 'drizzle-orm'
import type * as schema from '@memry/db-schema/data-schema'
import { noteMetadata } from '@memry/db-schema/data-schema'
import type { SyncAdapterRegistry } from '@memry/sync-core'
import { tasks } from '@memry/db-schema/schema/tasks'
import { projects } from '@memry/db-schema/schema/projects'
import { getNoteSyncService } from './note-sync'
import { getProjectSyncService } from './project-sync'
import { getTaskSyncService } from './task-sync'
import { createLogger } from '../lib/logger'

type DrizzleDb = BetterSQLite3Database<typeof schema>

const log = createLogger('DirtyRecovery')

export interface RecoveryResult {
  tasks: number
  projects: number
  notes: number
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

  const noteCount = recoverDirtyNotes(db, adapters)

  if (taskCount > 0 || projectCount > 0 || noteCount > 0) {
    log.info('Recovered dirty items for sync', {
      tasks: taskCount,
      projects: projectCount,
      notes: noteCount
    })
  }

  return { tasks: taskCount, projects: projectCount, notes: noteCount }
}

/**
 * Re-push notes whose last local change never reached the server.
 *
 * Note metadata (title, folder, tags, properties) rides the item queue, and a
 * push that is acknowledged while a fresh mutation sits in the same queue row
 * used to take that mutation to the grave with it — the local clock had already
 * advanced, so no later pull could repair the note and other devices kept the
 * stale title forever (notes created as 'Untitled' and renamed inside the push
 * window). Re-enqueueing here is what heals installs that already diverged.
 *
 * Scope is deliberately narrow: only notes the server already knows (`clock`
 * set) and that are not local-only. Clock-less notes belong to
 * `seedUnclockedNotes`, journals to the journal sync service. The recovered
 * enqueue reuses the stored clock instead of bumping it, so a note that is
 * actually in step is simply replay-detected by the server and stamped clean.
 */
function recoverDirtyNotes(
  db: DrizzleDb,
  adapters?: SyncAdapterRegistry<DrizzleDb, (channel: string, data: unknown) => void>
): number {
  const noteSync = adapters?.getLocal('note') ?? getNoteSyncService()
  if (!noteSync?.enqueueRecoveredUpdate) return 0

  const dirtyNotes = db
    .select({ id: noteMetadata.id })
    .from(noteMetadata)
    .where(
      and(
        isNotNull(noteMetadata.clock),
        isNull(noteMetadata.journalDate),
        sql`${noteMetadata.localOnly} IS NOT 1`,
        or(
          isNull(noteMetadata.syncedAt),
          and(isNotNull(noteMetadata.syncedAt), gt(noteMetadata.modifiedAt, noteMetadata.syncedAt))
        )
      )
    )
    .all()

  for (const note of dirtyNotes) {
    log.debug('Recovering dirty note', { noteId: note.id })
    noteSync.enqueueRecoveredUpdate(note.id)
  }

  return dirtyNotes.length
}
