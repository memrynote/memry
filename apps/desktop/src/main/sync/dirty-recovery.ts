import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { and, gt, isNull, isNotNull, or, sql } from 'drizzle-orm'
import type * as schema from '@memry/db-schema/data-schema'
import { noteMetadata } from '@memry/db-schema/data-schema'
import type { SyncAdapterRegistry } from '@memry/sync-core'
import { tasks } from '@memry/db-schema/schema/tasks'
import { projects } from '@memry/db-schema/schema/projects'
import { inboxItems } from '@memry/db-schema/schema/inbox'
import { getInboxSyncService } from './inbox-sync'
import { getJournalSyncService } from './journal-sync'
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
  journals: number
  inbox: number
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
  const journalCount = recoverDirtyJournals(db, adapters)
  const inboxCount = recoverDirtyInbox(db, adapters)

  if (taskCount > 0 || projectCount > 0 || noteCount > 0 || journalCount > 0 || inboxCount > 0) {
    log.info('Recovered dirty items for sync', {
      tasks: taskCount,
      projects: projectCount,
      notes: noteCount,
      journals: journalCount,
      inbox: inboxCount
    })
  }

  return {
    tasks: taskCount,
    projects: projectCount,
    notes: noteCount,
    journals: journalCount,
    inbox: inboxCount
  }
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
 * `seedUnclockedNotes`, journals to `recoverDirtyJournals` below — they are a
 * different sync service with a different payload builder, so they stay a
 * separate query rather than a branch in this one. The recovered enqueue reuses
 * the stored clock instead of bumping it, so a note that is actually in step is
 * simply replay-detected by the server and stamped clean.
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

/**
 * Heal inbox items whose triage state never left this device.
 *
 * Builds before #1159's fix filed items without enqueueing anything: `filedAt`,
 * `filedTo` and `filedAction` were written straight to the row, so the filing
 * never reached the other devices and the clock never advanced. Nothing else
 * repairs those rows on an existing install — `seedUnclocked` only picks rows
 * with a NULL clock, the manifest check is presence-based and the item is
 * present on the server, and `inbox/filing.ts` refuses to re-file an item that
 * already has a `filedAt`, so no later write ever touches them again. Without
 * this sweep they stay unpushed forever, and stay exposed to the stale-peer
 * push that reads their `filedAt: null` as a deliberate unfile.
 *
 * Same predicate as the arms above — `syncedAt IS NULL` or
 * `modifiedAt > syncedAt` — because filing does stamp `modifiedAt`. That keeps
 * the scan to one indexed-free table read that returns nothing on a healthy
 * install, instead of re-pushing the whole inbox at every launch. It is
 * self-clearing: the push stamps `syncedAt` past `modifiedAt`
 * (`inboxHandler.markPushSynced`), so the row is clean on the next launch, and
 * a row that never gets pushed is deduplicated by
 * `SyncQueueManager.enqueue()` on itemId+type+operation.
 *
 * Scope matches the note arm: only items the server already knows (`clock`
 * set — clock-less ones belong to `inboxHandler.seedUnclocked`) and not
 * local-only.
 *
 * Unlike tasks/projects/notes this deliberately goes through the ordinary
 * `enqueueUpdate`, which bumps the vector clock. `enqueueRecoveredUpdate`
 * exists to re-push a change whose clock was *already* advanced at write time;
 * these rows never got that far, so replaying their stored clock would lose to
 * any peer that has since moved on and the filing would be dropped a second
 * time. Bumping produces exactly the push the fix in `markItemAsFiled` would
 * have produced at filing time.
 */
function recoverDirtyInbox(
  db: DrizzleDb,
  adapters?: SyncAdapterRegistry<DrizzleDb, (channel: string, data: unknown) => void>
): number {
  const inboxSync = adapters?.getLocal('inbox') ?? getInboxSyncService()
  if (!inboxSync) return 0

  const dirtyItems = db
    .select({ id: inboxItems.id })
    .from(inboxItems)
    .where(
      and(
        isNotNull(inboxItems.clock),
        sql`${inboxItems.localOnly} IS NOT 1`,
        or(
          isNull(inboxItems.syncedAt),
          and(isNotNull(inboxItems.syncedAt), gt(inboxItems.modifiedAt, inboxItems.syncedAt))
        )
      )
    )
    .all()

  for (const item of dirtyItems) {
    log.debug('Recovering dirty inbox item', { itemId: item.id })
    inboxSync.enqueueUpdate(item.id)
  }

  return dirtyItems.length
}

/**
 * The journal half of the sweep above. Journals live in the same
 * `note_metadata` table but are pushed by their own sync service, so they need
 * their own query and their own enqueue — the note arm excludes them by
 * construction (`journalDate IS NULL`).
 *
 * Kept as a sibling rather than a branch inside `recoverDirtyNotes` on purpose:
 * the two route to different services, and the journal payload builder takes an
 * argument the note one does not. Folding them together would mean carrying the
 * date and a service switch through a query that currently needs neither.
 *
 * The `date` handed to `enqueueRecoveredUpdate` is load-bearing.
 * `JournalSyncService.buildSnapshotPayload` resolves the journal's file path
 * from it *before* its own try/catch, and `formatJournalFilename` does
 * `isoDate.split('-')`, so recovering a journal without one throws out of this
 * loop and takes the whole sweep — tasks, projects and notes included — with it.
 *
 * Same narrow scope as notes: only journals the server already knows (`clock`
 * set) and that are not local-only. Clock-less journals belong to
 * `journalHandler.seedUnclocked`. The enqueue reuses the stored clock rather
 * than bumping it, so a journal that is actually in step is replay-detected
 * server side and simply stamped as synced.
 */
function recoverDirtyJournals(
  db: DrizzleDb,
  adapters?: SyncAdapterRegistry<DrizzleDb, (channel: string, data: unknown) => void>
): number {
  const journalSync = adapters?.getLocal('journal') ?? getJournalSyncService()
  if (!journalSync?.enqueueRecoveredUpdate) return 0

  const dirtyJournals = db
    .select({ id: noteMetadata.id, journalDate: noteMetadata.journalDate })
    .from(noteMetadata)
    .where(
      and(
        isNotNull(noteMetadata.clock),
        isNotNull(noteMetadata.journalDate),
        sql`${noteMetadata.localOnly} IS NOT 1`,
        or(
          isNull(noteMetadata.syncedAt),
          and(isNotNull(noteMetadata.syncedAt), gt(noteMetadata.modifiedAt, noteMetadata.syncedAt))
        )
      )
    )
    .all()

  let recovered = 0
  for (const journal of dirtyJournals) {
    // Unreachable given the `isNotNull` above — but the date is what keeps the
    // payload builder from throwing, so it is narrowed here rather than asserted.
    if (!journal.journalDate) continue
    log.debug('Recovering dirty journal', { noteId: journal.id })
    journalSync.enqueueRecoveredUpdate(journal.id, journal.journalDate)
    recovered++
  }

  return recovered
}
