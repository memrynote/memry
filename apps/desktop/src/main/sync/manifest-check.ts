import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '@memry/db-schema/data-schema'
import { noteMetadata } from '@memry/db-schema/data-schema'
import { tasks } from '@memry/db-schema/schema/tasks'
import { projects } from '@memry/db-schema/schema/projects'
import { inboxItems } from '@memry/db-schema/schema/inbox'
import { savedFilters, settings } from '@memry/db-schema/schema/settings'
import { tagDefinitions } from '@memry/db-schema/schema/tag-definitions'
import { canvases } from '@memry/db-schema/schema/canvas'
import { bookmarks } from '@memry/db-schema/schema/bookmarks'
import { reminders } from '@memry/db-schema/schema/reminders'
import { noteCache } from '@memry/db-schema/schema/notes-cache'
import type { RecordSyncItemType, RecordSyncManifest } from '@memry/contracts/sync-api'
import { withRetry } from './retry'
import { toOutboundReminderPayload } from './reminder-outbound'
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

    const localItems = getLocalSyncableItems(deps.db)
    // A note held locally counts as present whether the server row calls it
    // 'note' or 'journal' — the classification is derived and must not make
    // the item look server-only.
    const localKeys = new Set(
      localItems.flatMap((l) =>
        l.type === 'note' || l.type === 'journal'
          ? [itemRefKey('note', l.id), itemRefKey('journal', l.id)]
          : [itemRefKey(l.type, l.id)]
      )
    )

    let reEnqueuedCount = 0
    for (const local of localItems) {
      const serverRef = serverItemMap.get(itemRefKey(local.type, local.id))

      if (!serverRef) {
        log.warn('Local item missing from server manifest, enqueuing as create', {
          id: local.id,
          type: local.type
        })

        deps.queue.enqueue({
          type: local.type,
          itemId: local.id,
          operation: 'create',
          payload: local.payload,
          priority: 0
        })
        reEnqueuedCount++
      }
    }

    const serverOnlyIds = result.value.items.filter(
      (item) =>
        !localKeys.has(itemRefKey(item.type, item.id)) && !deps.isQuarantined?.(item.id, item.type)
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

interface LocalSyncableItem {
  id: string
  type: RecordSyncItemType
  payload: string
}

function getLocalSyncableItems(db: DrizzleDb): LocalSyncableItem[] {
  const items: LocalSyncableItem[] = []
  const localIds = new Set<string>()
  // Dedup by (type, id): a bare-id dedup silently dropped the same-id sibling
  // of another type (project 'inbox' vs tag 'inbox'), making it look
  // server-only on every manifest check. Notes and journals stay one dedup
  // family: the same note id is listed by both the data DB and the index DB,
  // and their journal-ness classification must not create a double entry.
  const dedupKey = (item: LocalSyncableItem): string =>
    item.type === 'note' || item.type === 'journal'
      ? `note~journal:${item.id}`
      : itemRefKey(item.type, item.id)
  const addLocalItem = (item: LocalSyncableItem) => {
    const key = dedupKey(item)
    if (localIds.has(key)) return
    localIds.add(key)
    items.push(item)
  }

  const syncedTasks = db.select().from(tasks).where(isNotNull(tasks.clock)).all()
  for (const t of syncedTasks) {
    addLocalItem({ id: t.id, type: 'task', payload: JSON.stringify(t) })
  }

  const syncedProjects = db.select().from(projects).where(isNotNull(projects.clock)).all()
  for (const p of syncedProjects) {
    addLocalItem({ id: p.id, type: 'project', payload: JSON.stringify(p) })
  }

  const syncedInbox = db.select().from(inboxItems).where(isNotNull(inboxItems.clock)).all()
  for (const i of syncedInbox) {
    addLocalItem({ id: i.id, type: 'inbox', payload: JSON.stringify(i) })
  }

  const syncedFilters = db.select().from(savedFilters).where(isNotNull(savedFilters.clock)).all()
  for (const f of syncedFilters) {
    addLocalItem({ id: f.id, type: 'filter', payload: JSON.stringify(f) })
  }

  const syncedBookmarks = db.select().from(bookmarks).where(isNotNull(bookmarks.clock)).all()
  for (const b of syncedBookmarks) {
    addLocalItem({ id: b.id, type: 'bookmark', payload: JSON.stringify(b) })
  }

  // Device-local reminder fields are stripped by the same helper the real push
  // paths use, so this manifest payload matches exactly what reminder-sync.ts
  // and reminder-handler.ts send. A mismatch here reads as a spurious manifest
  // disagreement with the server. See reminder-outbound.ts.
  const syncedReminders = db.select().from(reminders).where(isNotNull(reminders.clock)).all()
  for (const r of syncedReminders) {
    addLocalItem({
      id: r.id,
      type: 'reminder',
      payload: JSON.stringify(toOutboundReminderPayload(r))
    })
  }

  // Diverges from the tasks template (D2): tombstones MUST be excluded. The
  // server manifest omits soft-deleted items, so a locally-tombstoned canvas
  // listed here would be seen as `!serverRef` and re-enqueued as a `create`,
  // NULLing the server's deleted_at and resurrecting the canvas fleet-wide
  // within 30 min. The payload is metadata-only (never the encrypted snapshot);
  // the re-enqueued push rebuilds the scene via canvas-handler.buildPushPayload.
  const syncedCanvases = db
    .select()
    .from(canvases)
    .where(and(isNotNull(canvases.clock), isNull(canvases.deletedAt)))
    .all()
  for (const c of syncedCanvases) {
    addLocalItem({
      id: c.id,
      type: 'canvas',
      payload: JSON.stringify({
        id: c.id,
        vaultId: c.vaultId,
        title: c.title,
        clock: c.clock,
        deletedAt: null
      })
    })
  }

  const syncedTagDefs = db
    .select()
    .from(tagDefinitions)
    .where(isNotNull(tagDefinitions.clock))
    .all()
  for (const td of syncedTagDefs) {
    addLocalItem({ id: td.name, type: 'tag_definition', payload: JSON.stringify(td) })
  }

  const syncedSettings = db.select().from(settings).where(eq(settings.key, 'synced_settings')).get()
  if (syncedSettings) {
    addLocalItem({
      id: 'synced_settings',
      type: 'settings',
      payload: JSON.stringify(syncedSettings)
    })
  }

  const syncedNoteMetadata = db
    .select({ id: noteMetadata.id, journalDate: noteMetadata.journalDate })
    .from(noteMetadata)
    .where(and(isNotNull(noteMetadata.clock), sql`${noteMetadata.localOnly} IS NOT 1`))
    .all()
  for (const n of syncedNoteMetadata) {
    addLocalItem({ id: n.id, type: n.journalDate ? 'journal' : 'note', payload: '' })
  }

  const indexDb = getIndexDatabase()

  const syncedNotes = indexDb
    .select({ id: noteCache.id })
    .from(noteCache)
    .where(and(isNotNull(noteCache.clock), isNull(noteCache.date)))
    .all()
  for (const n of syncedNotes) {
    addLocalItem({ id: n.id, type: 'note', payload: '' })
  }

  const syncedJournals = indexDb
    .select({ id: noteCache.id })
    .from(noteCache)
    .where(and(isNotNull(noteCache.clock), isNotNull(noteCache.date)))
    .all()
  for (const j of syncedJournals) {
    addLocalItem({ id: j.id, type: 'journal', payload: '' })
  }

  return items
}
