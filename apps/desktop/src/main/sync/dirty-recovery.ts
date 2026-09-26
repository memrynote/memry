import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import { and, gt, isNull, isNotNull, or, sql, type SQL } from 'drizzle-orm'
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'
import { RECORD_SYNC_ITEM_TYPES, type RecordSyncItemType } from '@memry/contracts/sync-api'
import { noteMetadata } from '@memry/db-schema/data-schema'
import type { RecordLocalSyncAdapter, SyncAdapterRegistry } from '@memry/sync-core'
import { tasks } from '@memry/db-schema/schema/tasks'
import { projects } from '@memry/db-schema/schema/projects'
import { inboxItems } from '@memry/db-schema/schema/inbox'
import { savedFilters } from '@memry/db-schema/schema/settings'
import { bookmarks } from '@memry/db-schema/schema/bookmarks'
import { templates } from '@memry/db-schema/schema/templates'
import { homePages } from '@memry/db-schema/schema/home-pages'
import { customIcons } from '@memry/db-schema/schema/custom-icons'
import { reminders } from '@memry/db-schema/schema/reminders'
import { canvasFolders } from '@memry/db-schema/schema/canvas-folder'
import { taskActivity } from '@memry/db-schema/schema/task-activity'
import { getInboxSyncService } from '@memry/sync-client/inbox-sync'
import { getFilterSyncService } from '@memry/sync-client/filter-sync'
import { getBookmarkSyncService } from '@memry/sync-client/bookmark-sync'
import { getTemplateSyncService } from '@memry/sync-client/template-sync'
import { getHomePageSyncService } from '@memry/sync-client/home-page-sync'
import { getCustomIconSyncService } from '@memry/sync-client/custom-icon-sync'
import { getReminderSyncService } from '@memry/sync-client/reminder-sync'
import { getCanvasFolderSyncService } from '@memry/sync-client/canvas-folder-sync'
import { getTaskActivitySyncService } from '@memry/sync-client/task-activity-sync'
import { taskActivityRetentionCutoff } from '@memry/sync-client/task-activity-retention'
import { getJournalSyncService } from './journal-sync'
import { getNoteSyncService } from './note-sync'
import { getProjectSyncService } from '@memry/sync-client/project-sync'
import { getTaskSyncService } from '@memry/sync-client/task-sync'
import { flushPendingLocalDeletes } from './local-mutations'
import { createLogger } from '../lib/logger'

const log = createLogger('DirtyRecovery')

type RecoveryAdapters = SyncAdapterRegistry<DrizzleDb, (channel: string, data: unknown) => void>

export interface RecoveryResult {
  tasks: number
  projects: number
  notes: number
  journals: number
  inbox: number
  /** Every swept type with at least one re-enqueued row, the five above included. */
  byType: Partial<Record<RecordSyncItemType, number>>
  /** Deletes raised while the sync runtime was down, replayed from tombstones. */
  deletes: number
}

interface DirtyRow {
  id: string
  syncedAt: string | number | null
  journalDate?: string | null
}

/**
 * How one record sync item type finds the rows it still owes the server and
 * hands them back to its local sync service. `enqueue` reports whether it did.
 */
interface DirtySweep {
  kind: 'sweep'
  /** Wrapped, not the bare getter: this table is built at import time. */
  service(): RecordLocalSyncAdapter | null | undefined
  select(db: DrizzleDb): DirtyRow[]
  enqueue(service: RecordLocalSyncAdapter, row: DirtyRow): boolean
}

/** A type with no startup sweep, and the one-line reason why. */
interface DirtySweepExemption {
  kind: 'exempt'
  reason: string
}

/**
 * Tasks, projects and the doc-clock record types: a never-synced row goes out
 * as a create, which bumps the clock; a row modified since its last sync is
 * re-pushed at its stored clock, which was already advanced when it was written.
 * Both paths rebind `_offline` ticks first (`recoverPendingChange`), so the
 * placeholder device id never reaches the wire (#2179, #2286).
 */
function enqueueCreateOrRecoveredUpdate(service: RecordLocalSyncAdapter, row: DirtyRow): boolean {
  if (!row.syncedAt) {
    service.enqueueCreate(row.id)
  } else if (service.enqueueRecoveredUpdate) {
    service.enqueueRecoveredUpdate(row.id)
  } else {
    service.enqueueUpdate(row.id)
  }
  return true
}

/**
 * Never pushed, or edited since the last push. `gt` against a NULL `syncedAt`
 * is NULL in SQLite, so the second arm needs no `IS NOT NULL` guard.
 */
function isDirty(syncedAt: SQLiteColumn, modifiedAt?: SQLiteColumn): SQL | undefined {
  return modifiedAt ? or(isNull(syncedAt), gt(modifiedAt, syncedAt)) : isNull(syncedAt)
}

const recoverDirtyTasks: DirtySweep = {
  kind: 'sweep',
  service: () => getTaskSyncService(),
  select: (db) =>
    db
      .select({ id: tasks.id, syncedAt: tasks.syncedAt })
      .from(tasks)
      .where(
        or(
          and(isNotNull(tasks.syncedAt), gt(tasks.modifiedAt, tasks.syncedAt)),
          isNull(tasks.syncedAt)
        )
      )
      .all(),
  enqueue: enqueueCreateOrRecoveredUpdate
}

const recoverDirtyProjects: DirtySweep = {
  kind: 'sweep',
  service: () => getProjectSyncService(),
  select: (db) =>
    db
      .select({ id: projects.id, syncedAt: projects.syncedAt })
      .from(projects)
      .where(
        or(
          and(isNotNull(projects.syncedAt), gt(projects.modifiedAt, projects.syncedAt)),
          isNull(projects.syncedAt)
        )
      )
      .all(),
  enqueue: enqueueCreateOrRecoveredUpdate
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
const recoverDirtyNotes: DirtySweep = {
  kind: 'sweep',
  service: () => getNoteSyncService(),
  select: (db) =>
    db
      .select({ id: noteMetadata.id, syncedAt: noteMetadata.syncedAt })
      .from(noteMetadata)
      .where(
        and(
          isNotNull(noteMetadata.clock),
          isNull(noteMetadata.journalDate),
          sql`${noteMetadata.localOnly} IS NOT 1`,
          or(
            isNull(noteMetadata.syncedAt),
            and(
              isNotNull(noteMetadata.syncedAt),
              gt(noteMetadata.modifiedAt, noteMetadata.syncedAt)
            )
          )
        )
      )
      .all(),
  enqueue: (noteSync, note) => {
    if (!noteSync.enqueueRecoveredUpdate) return false
    noteSync.enqueueRecoveredUpdate(note.id)
    return true
  }
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
const recoverDirtyInbox: DirtySweep = {
  kind: 'sweep',
  service: () => getInboxSyncService(),
  select: (db) =>
    db
      .select({ id: inboxItems.id, syncedAt: inboxItems.syncedAt })
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
      .all(),
  enqueue: (inboxSync, item) => {
    inboxSync.enqueueUpdate(item.id)
    return true
  }
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
 * loop and takes every other journal in the sweep with it.
 *
 * Same narrow scope as notes: only journals the server already knows (`clock`
 * set) and that are not local-only. Clock-less journals belong to
 * `journalHandler.seedUnclocked`. The enqueue reuses the stored clock rather
 * than bumping it, so a journal that is actually in step is replay-detected
 * server side and simply stamped as synced.
 */
const recoverDirtyJournals: DirtySweep = {
  kind: 'sweep',
  service: () => getJournalSyncService(),
  select: (db) =>
    db
      .select({
        id: noteMetadata.id,
        syncedAt: noteMetadata.syncedAt,
        journalDate: noteMetadata.journalDate
      })
      .from(noteMetadata)
      .where(
        and(
          isNotNull(noteMetadata.clock),
          isNotNull(noteMetadata.journalDate),
          sql`${noteMetadata.localOnly} IS NOT 1`,
          or(
            isNull(noteMetadata.syncedAt),
            and(
              isNotNull(noteMetadata.syncedAt),
              gt(noteMetadata.modifiedAt, noteMetadata.syncedAt)
            )
          )
        )
      )
      .all(),
  enqueue: (journalSync, journal) => {
    // Unreachable given the `isNotNull` above, but the date is what keeps the
    // payload builder from throwing, so it is narrowed here rather than asserted.
    if (!journalSync.enqueueRecoveredUpdate || !journal.journalDate) return false
    journalSync.enqueueRecoveredUpdate(journal.id, journal.journalDate)
    return true
  }
}

/**
 * The doc-clock record types below share one shape: a whole-row `clock`, a
 * `syncedAt` stamped by both `markPushSynced` and pull-apply, and a local sync
 * service whose `recoverPendingChange` rebinds `_offline` ticks. The clock is
 * the only thing that says the server has ever seen a row, so clock-less rows
 * are left to `seedUnclocked`, exactly as the note and inbox arms do.
 *
 * Filters, bookmarks and task activity have no modification timestamp, so only
 * a never-synced row is detectable. An edit to an already-pushed filter or
 * bookmark that loses its queue row stays uncovered until P4.2 (#2301); task
 * activity rows are immutable, so there is no such edit.
 */
const recoverDirtyFilters: DirtySweep = {
  kind: 'sweep',
  service: () => getFilterSyncService(),
  select: (db) =>
    db
      .select({ id: savedFilters.id, syncedAt: savedFilters.syncedAt })
      .from(savedFilters)
      .where(and(isNotNull(savedFilters.clock), isDirty(savedFilters.syncedAt)))
      .all(),
  enqueue: enqueueCreateOrRecoveredUpdate
}

const recoverDirtyBookmarks: DirtySweep = {
  kind: 'sweep',
  service: () => getBookmarkSyncService(),
  select: (db) =>
    db
      .select({ id: bookmarks.id, syncedAt: bookmarks.syncedAt })
      .from(bookmarks)
      .where(and(isNotNull(bookmarks.clock), isDirty(bookmarks.syncedAt)))
      .all(),
  enqueue: enqueueCreateOrRecoveredUpdate
}

const recoverDirtyTemplates: DirtySweep = {
  kind: 'sweep',
  service: () => getTemplateSyncService(),
  select: (db) =>
    db
      .select({ id: templates.id, syncedAt: templates.syncedAt })
      .from(templates)
      .where(and(isNotNull(templates.clock), isDirty(templates.syncedAt, templates.modifiedAt)))
      .all(),
  enqueue: enqueueCreateOrRecoveredUpdate
}

const recoverDirtyHomePages: DirtySweep = {
  kind: 'sweep',
  service: () => getHomePageSyncService(),
  select: (db) =>
    db
      .select({ id: homePages.id, syncedAt: homePages.syncedAt })
      .from(homePages)
      .where(and(isNotNull(homePages.clock), isDirty(homePages.syncedAt, homePages.updatedAt)))
      .all(),
  enqueue: enqueueCreateOrRecoveredUpdate
}

const recoverDirtyCustomIcons: DirtySweep = {
  kind: 'sweep',
  service: () => getCustomIconSyncService(),
  select: (db) =>
    db
      .select({ id: customIcons.id, syncedAt: customIcons.syncedAt })
      .from(customIcons)
      .where(
        and(isNotNull(customIcons.clock), isDirty(customIcons.syncedAt, customIcons.updatedAt))
      )
      .all(),
  enqueue: enqueueCreateOrRecoveredUpdate
}

/**
 * A reminder firing moves `modifiedAt` without a push (`status: 'triggered'` is
 * device-local), so this also re-pushes fired reminders once. That is harmless:
 * the recovered update replays the stored clock with the device-local fields
 * stripped, the server refuses it as a replay, and the refusal stamps the row.
 */
const recoverDirtyReminders: DirtySweep = {
  kind: 'sweep',
  service: () => getReminderSyncService(),
  select: (db) =>
    db
      .select({ id: reminders.id, syncedAt: reminders.syncedAt })
      .from(reminders)
      .where(and(isNotNull(reminders.clock), isDirty(reminders.syncedAt, reminders.modifiedAt)))
      .all(),
  enqueue: enqueueCreateOrRecoveredUpdate
}

/**
 * Epoch-ms columns, compared with each other only. Tombstones are skipped: a
 * soft-deleted folder re-pushed as a create or update would resurrect it, and
 * its delete is replayed from `sync_pending_deletes` instead.
 */
const recoverDirtyCanvasFolders: DirtySweep = {
  kind: 'sweep',
  service: () => getCanvasFolderSyncService(),
  select: (db) =>
    db
      .select({ id: canvasFolders.id, syncedAt: canvasFolders.syncedAt })
      .from(canvasFolders)
      .where(
        and(
          isNotNull(canvasFolders.clock),
          isNull(canvasFolders.deletedAt),
          isDirty(canvasFolders.syncedAt, canvasFolders.updatedAt)
        )
      )
      .all(),
  enqueue: enqueueCreateOrRecoveredUpdate
}

/**
 * Same retention cutoff as `seedUnclocked` and apply: pushing an expired row
 * would hand it back to peers that already pruned it.
 */
const recoverDirtyTaskActivity: DirtySweep = {
  kind: 'sweep',
  service: () => getTaskActivitySyncService(),
  select: (db) =>
    db
      .select({ id: taskActivity.id, syncedAt: taskActivity.syncedAt })
      .from(taskActivity)
      .where(
        and(
          isNotNull(taskActivity.clock),
          isDirty(taskActivity.syncedAt),
          sql`${taskActivity.createdAt} >= ${taskActivityRetentionCutoff()}`
        )
      )
      .all(),
  enqueue: enqueueCreateOrRecoveredUpdate
}

const RELIES_ON_P4_2 = 'Relies on the transactional outbox, P4.2 (#2301).'

/**
 * Startup safety net for every record sync item type (#2286). A local edit
 * writes the row, then the clock, then the outbox row, in three transactions;
 * a crash between the last two, or any `increment*ClockOffline` fallback,
 * leaves a clocked row with no queue row and nothing else ever pushes it.
 *
 * Keyed by `RecordSyncItemType`, so a new type does not compile until it is
 * given a sweep or an exemption, and `dirty-recovery.test.ts` enumerates
 * `RECORD_SYNC_ITEM_TYPES` against this table.
 */
export const DIRTY_RECOVERY: Record<RecordSyncItemType, DirtySweep | DirtySweepExemption> = {
  note: recoverDirtyNotes,
  task: recoverDirtyTasks,
  project: recoverDirtyProjects,
  settings: {
    kind: 'exempt',
    reason: `Singleton with no syncedAt column, so no dirty marker. ${RELIES_ON_P4_2}`
  },
  inbox: recoverDirtyInbox,
  filter: recoverDirtyFilters,
  journal: recoverDirtyJournals,
  tag_definition: { kind: 'exempt', reason: `No syncedAt column. ${RELIES_ON_P4_2}` },
  tag_category: { kind: 'exempt', reason: `No syncedAt column. ${RELIES_ON_P4_2}` },
  property_definition: {
    kind: 'exempt',
    reason: `syncedAt is stamped by pull-apply only, never after a push, so NULL marks every locally made definition. ${RELIES_ON_P4_2}`
  },
  folder_config: { kind: 'exempt', reason: `No syncedAt column. ${RELIES_ON_P4_2}` },
  custom_icon: recoverDirtyCustomIcons,
  calendar_event: {
    kind: 'exempt',
    reason: `syncedAt is never stamped by a push (no markPushSynced), so it carries no dirty signal. ${RELIES_ON_P4_2}`
  },
  calendar_source: {
    kind: 'exempt',
    reason: `syncedAt is never stamped by a push (no markPushSynced), so it carries no dirty signal. ${RELIES_ON_P4_2}`
  },
  calendar_binding: {
    kind: 'exempt',
    reason: `syncedAt is the provider write-engine's bookkeeping, never stamped by a push. ${RELIES_ON_P4_2}`
  },
  calendar_external_event: {
    kind: 'exempt',
    reason: `syncedAt is never stamped by a push (no markPushSynced), so it carries no dirty signal. ${RELIES_ON_P4_2}`
  },
  agent_conversation: {
    kind: 'exempt',
    reason: 'Desktop has no local push path for this type (agent/sync/backfill.ts is not wired).'
  },
  agent_message: {
    kind: 'exempt',
    reason: 'Desktop has no local push path for this type, and no syncedAt column.'
  },
  canvas: {
    kind: 'exempt',
    reason: `updatedAt > lastSyncedAt is no dirty signal: a scene over the sync cap is kept local on purpose (canvas/sync-bridge.ts) and a sweep would push it. ${RELIES_ON_P4_2}`
  },
  canvas_folder: recoverDirtyCanvasFolders,
  bookmark: recoverDirtyBookmarks,
  reminder: recoverDirtyReminders,
  template: recoverDirtyTemplates,
  task_activity: recoverDirtyTaskActivity,
  home_page: recoverDirtyHomePages
}

/**
 * Scans for locally-modified items that were never synced (e.g. edited while signed out).
 * Re-enqueues them for the next sync cycle, rebinding offline placeholder clocks when present.
 *
 * Detection: modifiedAt > syncedAt (modified since last sync) OR syncedAt IS NULL (never synced),
 * per type as declared in `DIRTY_RECOVERY`.
 * Safe to call multiple times — SyncQueueManager.enqueue() deduplicates by itemId+type+operation.
 */
export function recoverDirtyItems(db: DrizzleDb, adapters?: RecoveryAdapters): RecoveryResult {
  const byType: Partial<Record<RecordSyncItemType, number>> = {}

  for (const type of RECORD_SYNC_ITEM_TYPES) {
    const entry = DIRTY_RECOVERY[type]
    if (entry.kind === 'exempt') continue

    const service = adapters?.getLocal(type) ?? entry.service()
    if (!service) continue

    // Runs synchronously inside sync runtime start: one type's failure must not
    // cost every other type its sweep, or abort the start.
    try {
      let recovered = 0
      for (const row of entry.select(db)) {
        log.debug('Recovering dirty item', { type, itemId: row.id, syncedAt: row.syncedAt })
        if (entry.enqueue(service, row)) recovered++
      }
      if (recovered > 0) byType[type] = recovered
    } catch (err) {
      log.warn('Dirty recovery failed for a sync type', { type, error: err })
    }
  }

  // The delete half of the same sweep. Create and update leave a dirty row the
  // queries above find; a delete leaves no row at all, so it is captured as a
  // tombstone when it is raised and replayed here instead (#1579).
  const deleteCount = flushPendingLocalDeletes(db)

  if (Object.keys(byType).length > 0) {
    log.info('Recovered dirty items for sync', byType)
  }

  return {
    tasks: byType.task ?? 0,
    projects: byType.project ?? 0,
    notes: byType.note ?? 0,
    journals: byType.journal ?? 0,
    inbox: byType.inbox ?? 0,
    byType,
    deletes: deleteCount
  }
}
