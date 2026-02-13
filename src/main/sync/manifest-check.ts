import { isNotNull } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '@shared/db/schema/data-schema'
import { tasks } from '@shared/db/schema/tasks'
import { inboxItems } from '@shared/db/schema/inbox'
import { savedFilters } from '@shared/db/schema/settings'
import type { SyncManifest } from '@shared/contracts/sync-api'
import { withRetry } from './retry'
import { getFromServer } from './http-client'
import type { SyncQueueManager } from './queue'
import { createLogger } from '../lib/logger'

type DrizzleDb = BetterSQLite3Database<typeof schema>

const log = createLogger('ManifestCheck')

const MIN_INTERVAL_MS = 30 * 60 * 1000

let lastCheckAt = 0

interface ManifestCheckDeps {
  db: DrizzleDb
  queue: SyncQueueManager
  getAccessToken: () => Promise<string | null>
  isOnline: () => boolean
}

export async function checkManifestIntegrity(deps: ManifestCheckDeps): Promise<void> {
  const now = Date.now()
  if (now - lastCheckAt < MIN_INTERVAL_MS) return
  lastCheckAt = now

  const token = await deps.getAccessToken()
  if (!token) return

  try {
    const result = await withRetry(() => getFromServer<SyncManifest>('/sync/manifest', token), {
      isOnline: deps.isOnline
    })

    const serverItemIds = new Set(result.value.items.map((item) => item.id))

    const localItems = getLocalSyncableItems(deps.db)
    if (localItems.length === 0) return

    let reEnqueuedCount = 0
    for (const local of localItems) {
      if (!serverItemIds.has(local.id)) {
        log.warn('Local item missing from server manifest, re-enqueuing', {
          id: local.id,
          type: local.type
        })

        deps.queue.enqueue({
          type: local.type,
          itemId: local.id,
          operation: 'update',
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
      log.warn('Server has items not found locally, may need re-pull', {
        count: serverOnlyIds.length
      })
    }

    if (reEnqueuedCount > 0) {
      log.info('Manifest check complete', { reEnqueued: reEnqueuedCount })
    }
  } catch (err) {
    log.error('Manifest integrity check failed', err)
  }
}

interface LocalSyncableItem {
  id: string
  type: 'task' | 'inbox' | 'filter'
  payload: string
}

function getLocalSyncableItems(db: DrizzleDb): LocalSyncableItem[] {
  const items: LocalSyncableItem[] = []

  const syncedTasks = db.select().from(tasks).where(isNotNull(tasks.clock)).all()
  for (const t of syncedTasks) {
    items.push({ id: t.id, type: 'task', payload: JSON.stringify(t) })
  }

  const syncedInbox = db.select().from(inboxItems).where(isNotNull(inboxItems.clock)).all()
  for (const i of syncedInbox) {
    items.push({ id: i.id, type: 'inbox', payload: JSON.stringify(i) })
  }

  const syncedFilters = db.select().from(savedFilters).where(isNotNull(savedFilters.clock)).all()
  for (const f of syncedFilters) {
    items.push({ id: f.id, type: 'filter', payload: JSON.stringify(f) })
  }

  return items
}
