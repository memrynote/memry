import { and, eq, gte, isNotNull, isNull, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '@memry/db-schema/data-schema'
import { noteMetadata } from '@memry/db-schema/data-schema'
import { tasks } from '@memry/db-schema/schema/tasks'
import { taskActivity } from '@memry/db-schema/schema/task-activity'
import { projects } from '@memry/db-schema/schema/projects'
import { inboxItems } from '@memry/db-schema/schema/inbox'
import { savedFilters, settings } from '@memry/db-schema/schema/settings'
import { tagDefinitions } from '@memry/db-schema/schema/tag-definitions'
import { canvases } from '@memry/db-schema/schema/canvas'
import { canvasFolders } from '@memry/db-schema/schema/canvas-folder'
import { bookmarks } from '@memry/db-schema/schema/bookmarks'
import { templates } from '@memry/db-schema/schema/templates'
import { reminders } from '@memry/db-schema/schema/reminders'
import { noteCache } from '@memry/db-schema/schema/notes-cache'
import type { RecordSyncItemType, RecordSyncManifest } from '@memry/contracts/sync-api'
import { withRetry } from './retry'
import { toOutboundReminderPayload } from './reminder-outbound'
import { taskActivityRetentionCutoff } from './task-activity-retention'
import { getFromServer } from './http-client'
import { itemRefKey } from './engine/sync-context'
import type { SyncQueueManager } from './queue'
import { getIndexDatabase } from '../database/client'
import { createLogger } from '../lib/logger'

type DrizzleDb = BetterSQLite3Database<typeof schema>

const log = createLogger('ManifestCheck')

const MIN_INTERVAL_MS = 30 * 60 * 1000

interface ManifestCheckDeps {
  db: DrizzleDb
  queue: SyncQueueManager
  getAccessToken: () => Promise<string | null>
  isOnline: () => boolean
  lastCheckAt?: number
  /** Excludes quarantined items from the server-only diff — a permanently
   * quarantined item is skipped on every pull, so counting it server-only
   * would reset the cursor and re-pull the whole vault on every check. */
  isQuarantined?: (itemId: string, itemType: string) => boolean
}

export interface ManifestCheckResult {
  checkedAt: number
  rePullNeeded: boolean
  serverOnlyCount: number
  /** True only when a manifest was actually fetched and diffed. */
  performed: boolean
}

export async function checkManifestIntegrity(
  deps: ManifestCheckDeps
): Promise<ManifestCheckResult> {
  const now = Date.now()
  const noAction: ManifestCheckResult = {
    checkedAt: deps.lastCheckAt ?? 0,
    rePullNeeded: false,
    serverOnlyCount: 0,
    performed: false
  }

  if (now - (deps.lastCheckAt ?? 0) < MIN_INTERVAL_MS) return noAction

  const token = await deps.getAccessToken()
  if (!token) return { checkedAt: now, rePullNeeded: false, serverOnlyCount: 0, performed: false }

  try {
    const result = await withRetry(
      () => getFromServer<RecordSyncManifest>('/sync/manifest', token),
      {
        isOnline: deps.isOnline
      }
    )

    // Ids repeat across item types (project 'inbox' vs tag 'inbox'), so both
    // diff directions must compare (type, id) pairs — an id-only diff hides a
    // missing item behind its same-id sibling of another type, and counts a
    // quarantined sibling as "server-only" forever (endless re-pull loop).
    const serverItemMap = new Map(
      result.value.items.map((item) => [itemRefKey(item.type, item.id), item])
    )

    const localRefs = getLocalSyncableRefs(deps.db)
    // A note held locally counts as present whether the server row calls it
    // 'note' or 'journal' — the classification is derived and must not make
    // the item look server-only.
    const localKeys = new Set(
      localRefs.flatMap((l) =>
        l.type === 'note' || l.type === 'journal'
          ? [itemRefKey('note', l.id), itemRefKey('journal', l.id)]
          : [itemRefKey(l.type, l.id)]
      )
    )

    let reEnqueuedCount = 0
    for (const local of localRefs) {
      const serverRef = serverItemMap.get(itemRefKey(local.type, local.id))

      if (!serverRef) {
        // Payloads are built here and only here: the diff above needs nothing
        // but (type, id), so a clean vault never materializes a single row.
        const payload = buildRefPayload(deps.db, local)
        if (payload === null) {
          log.warn('Local item missing from server manifest but row is gone, skipping', {
            id: local.id,
            type: local.type
          })
          continue
        }

        log.warn('Local item missing from server manifest, enqueuing as create', {
          id: local.id,
          type: local.type
        })

        deps.queue.enqueue({
          type: local.type,
          itemId: local.id,
          operation: 'create',
          payload,
          priority: 0
        })
        reEnqueuedCount++
      }
    }

    const serverOnlyIds = result.value.items.filter(
      (item) =>
        // `task_activity` is exempt in this direction only. Rows past the
        // retention cutoff are skipped on apply and pruned locally by design, so
        // the server legitimately holds rows this device will never have.
        // Counting them would set `rePullNeeded` on every manifest check for the
        // rest of the vault's life. The local→server direction above still
        // repairs activity rows that never reached the server.
        item.type !== 'task_activity' &&
        !localKeys.has(itemRefKey(item.type, item.id)) &&
        !deps.isQuarantined?.(item.id, item.type)
    )
    if (serverOnlyIds.length > 0) {
      log.warn('Server has items not found locally, will trigger re-pull', {
        count: serverOnlyIds.length
      })
    }

    if (reEnqueuedCount > 0) {
      log.info('Manifest check complete', { reEnqueued: reEnqueuedCount })
    }

    return {
      checkedAt: now,
      rePullNeeded: serverOnlyIds.length > 0,
      serverOnlyCount: serverOnlyIds.length,
      performed: true
    }
  } catch (err) {
    log.error('Manifest integrity check failed', err)
    return { checkedAt: now, rePullNeeded: false, serverOnlyCount: 0, performed: false }
  }
}

interface LocalSyncableRef {
  id: string
  type: RecordSyncItemType
}

/**
 * Ids and types only — deliberately no row bodies. The manifest diff compares
 * (type, id) pairs, and payloads are only ever needed for the rare ref the
 * server manifest is missing, so materializing every row up front was pure
 * waste on the clean path. `buildRefPayload` fetches those rows lazily.
 */
function getLocalSyncableRefs(db: DrizzleDb): LocalSyncableRef[] {
  const refs: LocalSyncableRef[] = []
  const localIds = new Set<string>()
  // Dedup by (type, id): a bare-id dedup silently dropped the same-id sibling
  // of another type (project 'inbox' vs tag 'inbox'), making it look
  // server-only on every manifest check. Notes and journals stay one dedup
  // family: the same note id is listed by both the data DB and the index DB,
  // and their journal-ness classification must not create a double entry.
  const dedupKey = (ref: LocalSyncableRef): string =>
    ref.type === 'note' || ref.type === 'journal'
      ? `note~journal:${ref.id}`
      : itemRefKey(ref.type, ref.id)
  const addLocalRef = (ref: LocalSyncableRef) => {
    const key = dedupKey(ref)
    if (localIds.has(key)) return
    localIds.add(key)
    refs.push(ref)
  }

  const syncedTasks = db.select({ id: tasks.id }).from(tasks).where(isNotNull(tasks.clock)).all()
  for (const t of syncedTasks) {
    addLocalRef({ id: t.id, type: 'task' })
  }

  const syncedProjects = db
    .select({ id: projects.id })
    .from(projects)
    .where(isNotNull(projects.clock))
    .all()
  for (const p of syncedProjects) {
    addLocalRef({ id: p.id, type: 'project' })
  }

  const syncedInbox = db
    .select({ id: inboxItems.id })
    .from(inboxItems)
    .where(isNotNull(inboxItems.clock))
    .all()
  for (const i of syncedInbox) {
    addLocalRef({ id: i.id, type: 'inbox' })
  }

  const syncedFilters = db
    .select({ id: savedFilters.id })
    .from(savedFilters)
    .where(isNotNull(savedFilters.clock))
    .all()
  for (const f of syncedFilters) {
    addLocalRef({ id: f.id, type: 'filter' })
  }

  // Only rows still inside the retention window: an expired row re-pushed from
  // here would land on peers that have already pruned it, and their apply would
  // reject it anyway.
  const syncedTaskActivity = db
    .select({ id: taskActivity.id })
    .from(taskActivity)
    .where(
      and(isNotNull(taskActivity.clock), gte(taskActivity.createdAt, taskActivityRetentionCutoff()))
    )
    .all()
  for (const a of syncedTaskActivity) {
    addLocalRef({ id: a.id, type: 'task_activity' })
  }

  // Tombstones MUST be excluded, for the same reason the canvases block below
  // excludes them: the server manifest omits soft-deleted items, so a
  // locally-tombstoned folder listed here is seen as `!serverRef` and
  // re-enqueued as a `create`, NULLing the server's deleted_at and bringing the
  // folder back on every device within 30 minutes.
  const syncedCanvasFolders = db
    .select({ id: canvasFolders.id })
    .from(canvasFolders)
    .where(and(isNotNull(canvasFolders.clock), isNull(canvasFolders.deletedAt)))
    .all()
  for (const f of syncedCanvasFolders) {
    addLocalRef({ id: f.id, type: 'canvas_folder' })
  }

  const syncedTemplates = db
    .select({ id: templates.id })
    .from(templates)
    .where(isNotNull(templates.clock))
    .all()
  for (const t of syncedTemplates) {
    addLocalRef({ id: t.id, type: 'template' })
  }

  const syncedBookmarks = db
    .select({ id: bookmarks.id })
    .from(bookmarks)
    .where(isNotNull(bookmarks.clock))
    .all()
  for (const b of syncedBookmarks) {
    addLocalRef({ id: b.id, type: 'bookmark' })
  }

  const syncedReminders = db
    .select({ id: reminders.id })
    .from(reminders)
    .where(isNotNull(reminders.clock))
    .all()
  for (const r of syncedReminders) {
    addLocalRef({ id: r.id, type: 'reminder' })
  }

  // Diverges from the tasks template (D2): tombstones MUST be excluded. The
  // server manifest omits soft-deleted items, so a locally-tombstoned canvas
  // listed here would be seen as `!serverRef` and re-enqueued as a `create`,
  // NULLing the server's deleted_at and resurrecting the canvas fleet-wide
  // within 30 min.
  const syncedCanvases = db
    .select({ id: canvases.id })
    .from(canvases)
    .where(and(isNotNull(canvases.clock), isNull(canvases.deletedAt)))
    .all()
  for (const c of syncedCanvases) {
    addLocalRef({ id: c.id, type: 'canvas' })
  }

  const syncedTagDefs = db
    .select({ name: tagDefinitions.name })
    .from(tagDefinitions)
    .where(isNotNull(tagDefinitions.clock))
    .all()
  for (const td of syncedTagDefs) {
    addLocalRef({ id: td.name, type: 'tag_definition' })
  }

  const syncedSettings = db
    .select({ key: settings.key })
    .from(settings)
    .where(eq(settings.key, 'synced_settings'))
    .get()
  if (syncedSettings) {
    addLocalRef({ id: 'synced_settings', type: 'settings' })
  }

  const syncedNoteMetadata = db
    .select({ id: noteMetadata.id, journalDate: noteMetadata.journalDate })
    .from(noteMetadata)
    .where(and(isNotNull(noteMetadata.clock), sql`${noteMetadata.localOnly} IS NOT 1`))
    .all()
  for (const n of syncedNoteMetadata) {
    addLocalRef({ id: n.id, type: n.journalDate ? 'journal' : 'note' })
  }

  const indexDb = getIndexDatabase()

  const syncedNotes = indexDb
    .select({ id: noteCache.id })
    .from(noteCache)
    .where(and(isNotNull(noteCache.clock), isNull(noteCache.date)))
    .all()
  for (const n of syncedNotes) {
    addLocalRef({ id: n.id, type: 'note' })
  }

  const syncedJournals = indexDb
    .select({ id: noteCache.id })
    .from(noteCache)
    .where(and(isNotNull(noteCache.clock), isNotNull(noteCache.date)))
    .all()
  for (const j of syncedJournals) {
    addLocalRef({ id: j.id, type: 'journal' })
  }

  return refs
}

/**
 * Materializes the repair payload for one ref, byte-identical to the eager
 * pass this replaced: the same full-row select feeds the same `JSON.stringify`,
 * so what a manifest repair pushes is unchanged for existing installs.
 * Returns null when the row is gone (nothing to re-create).
 */
function buildRefPayload(db: DrizzleDb, ref: LocalSyncableRef): string | null {
  switch (ref.type) {
    case 'task': {
      const row = db.select().from(tasks).where(eq(tasks.id, ref.id)).get()
      return row ? JSON.stringify(row) : null
    }
    case 'project': {
      const row = db.select().from(projects).where(eq(projects.id, ref.id)).get()
      return row ? JSON.stringify(row) : null
    }
    case 'inbox': {
      const row = db.select().from(inboxItems).where(eq(inboxItems.id, ref.id)).get()
      return row ? JSON.stringify(row) : null
    }
    case 'filter': {
      const row = db.select().from(savedFilters).where(eq(savedFilters.id, ref.id)).get()
      return row ? JSON.stringify(row) : null
    }
    case 'task_activity': {
      const row = db.select().from(taskActivity).where(eq(taskActivity.id, ref.id)).get()
      return row ? JSON.stringify(row) : null
    }
    case 'template': {
      const row = db.select().from(templates).where(eq(templates.id, ref.id)).get()
      return row ? JSON.stringify(row) : null
    }
    case 'bookmark': {
      const row = db.select().from(bookmarks).where(eq(bookmarks.id, ref.id)).get()
      return row ? JSON.stringify(row) : null
    }
    // Device-local reminder fields are stripped by the same helper the real push
    // paths use, so this manifest payload matches exactly what reminder-sync.ts
    // and reminder-handler.ts send. A mismatch here reads as a spurious manifest
    // disagreement with the server. See reminder-outbound.ts.
    case 'reminder': {
      const row = db.select().from(reminders).where(eq(reminders.id, ref.id)).get()
      return row ? JSON.stringify(toOutboundReminderPayload(row)) : null
    }
    // Metadata-only (never the encrypted snapshot); the re-enqueued push
    // rebuilds the scene via canvas-handler.buildPushPayload.
    case 'canvas': {
      const row = db.select().from(canvases).where(eq(canvases.id, ref.id)).get()
      return row
        ? JSON.stringify({
            id: row.id,
            vaultId: row.vaultId,
            title: row.title,
            clock: row.clock,
            deletedAt: null
          })
        : null
    }
    case 'canvas_folder': {
      const row = db.select().from(canvasFolders).where(eq(canvasFolders.id, ref.id)).get()
      return row ? JSON.stringify(row) : null
    }
    case 'tag_definition': {
      const row = db.select().from(tagDefinitions).where(eq(tagDefinitions.name, ref.id)).get()
      return row ? JSON.stringify(row) : null
    }
    case 'settings': {
      const row = db.select().from(settings).where(eq(settings.key, 'synced_settings')).get()
      return row ? JSON.stringify(row) : null
    }
    // Note and journal bodies never travel in the manifest payload — the CRDT
    // push path owns them. The eager pass emitted '' here too.
    default:
      return ''
  }
}
