import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '@memry/db-schema/data-schema'
import { tasks } from '@memry/db-schema/schema/tasks'
import { projects } from '@memry/db-schema/schema/projects'
import { inboxItems } from '@memry/db-schema/schema/inbox'
import { savedFilters, settings } from '@memry/db-schema/schema/settings'
import { tagDefinitions } from '@memry/db-schema/schema/tag-definitions'
import { noteCache } from '@memry/db-schema/schema/notes-cache'
import type { RecordSyncItemType, RecordSyncManifest } from '@memry/contracts/sync-api'
import { withRetry } from './retry'
import { getFromServer } from './http-client'
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
}

export interface ManifestCheckResult {
  checkedAt: number
  rePullNeeded: boolean
  serverOnlyCount: number
}

export async function checkManifestIntegrity(
  deps: ManifestCheckDeps
): Promise<ManifestCheckResult> {
  const now = Date.now()
  const noAction: ManifestCheckResult = {
    checkedAt: deps.lastCheckAt ?? 0,
    rePullNeeded: false,
    serverOnlyCount: 0
  }

  if (now - (deps.lastCheckAt ?? 0) < MIN_INTERVAL_MS) return noAction

  const token = await deps.getAccessToken()
  if (!token) return { checkedAt: now, rePullNeeded: false, serverOnlyCount: 0 }

  try {
    const result = await withRetry(
      () => getFromServer<RecordSyncManifest>('/sync/manifest', token),
      {
        isOnline: deps.isOnline
      }
    )

    const serverItemMap = new Map(result.value.items.map((item) => [item.id, item]))

    const localItems = getLocalSyncableItems(deps.db)

    let reEnqueuedCount = 0
    for (const local of localItems) {
      const serverRef = serverItemMap.get(local.id)

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
      (item) => !localItems.some((l) => l.id === item.id)
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
      serverOnlyCount: serverOnlyIds.length
    }
  } catch (err) {
    log.error('Manifest integrity check failed', err)
    return { checkedAt: now, rePullNeeded: false, serverOnlyCount: 0 }
  }
}

interface LocalSyncableItem {
  id: string
  type: RecordSyncItemType
  payload: string
}

function getLocalSyncableItems(db: DrizzleDb): LocalSyncableItem[] {
  const items: LocalSyncableItem[] = []

  const syncedTasks = db.select().from(tasks).where(isNotNull(tasks.clock)).all()
  for (const t of syncedTasks) {
    items.push({ id: t.id, type: 'task', payload: JSON.stringify(t) })
  }

  const syncedProjects = db.select().from(projects).where(isNotNull(projects.clock)).all()
  for (const p of syncedProjects) {
    items.push({ id: p.id, type: 'project', payload: JSON.stringify(p) })
  }

  const syncedInbox = db.select().from(inboxItems).where(isNotNull(inboxItems.clock)).all()
  for (const i of syncedInbox) {
    items.push({ id: i.id, type: 'inbox', payload: JSON.stringify(i) })
  }

  const syncedFilters = db.select().from(savedFilters).where(isNotNull(savedFilters.clock)).all()
  for (const f of syncedFilters) {
    items.push({ id: f.id, type: 'filter', payload: JSON.stringify(f) })
  }

  const syncedTagDefs = db
    .select()
    .from(tagDefinitions)
    .where(isNotNull(tagDefinitions.clock))
    .all()
  for (const td of syncedTagDefs) {
    items.push({ id: td.name, type: 'tag_definition', payload: JSON.stringify(td) })
  }

  const syncedSettings = db.select().from(settings).where(eq(settings.key, 'synced_settings')).get()
  if (syncedSettings) {
    items.push({ id: 'synced_settings', type: 'settings', payload: JSON.stringify(syncedSettings) })
  }

  const indexDb = getIndexDatabase()

  const syncedNotes = indexDb
    .select({ id: noteCache.id })
    .from(noteCache)
    .where(and(isNotNull(noteCache.clock), isNull(noteCache.date)))
    .all()
  for (const n of syncedNotes) {
    items.push({ id: n.id, type: 'note', payload: '' })
  }

  const syncedJournals = indexDb
    .select({ id: noteCache.id })
    .from(noteCache)
    .where(and(isNotNull(noteCache.clock), isNotNull(noteCache.date)))
    .all()
  for (const j of syncedJournals) {
    items.push({ id: j.id, type: 'journal', payload: '' })
  }

  return items
}
