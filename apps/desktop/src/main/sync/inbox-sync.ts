import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import type * as schema from '@memry/db-schema/data-schema'
import { inboxItems } from '@memry/db-schema/schema/inbox'
import type { VectorClock } from '@memry/contracts/sync-api'
import type { SyncQueueManager } from './queue'
import { increment } from './vector-clock'
import { createLogger } from '../lib/logger'

type DrizzleDb = BetterSQLite3Database<typeof schema>

const log = createLogger('InboxSync')

interface InboxSyncDeps {
  queue: SyncQueueManager
  db: DrizzleDb
  getDeviceId: () => string | null
}

let instance: InboxSyncService | null = null

export function initInboxSyncService(deps: InboxSyncDeps): InboxSyncService {
  instance = new InboxSyncService(deps)
  return instance
}

export function getInboxSyncService(): InboxSyncService | null {
  return instance
}

export function resetInboxSyncService(): void {
  instance = null
}

export class InboxSyncService {
  private queue: SyncQueueManager
  private db: DrizzleDb
  private getDeviceId: () => string | null

  constructor(deps: InboxSyncDeps) {
    this.queue = deps.queue
    this.db = deps.db
    this.getDeviceId = deps.getDeviceId
  }

  enqueueCreate(itemId: string): void {
    this.enqueue(itemId, 'create')
  }

  enqueueUpdate(itemId: string): void {
    this.enqueue(itemId, 'update')
  }

  enqueueDelete(itemId: string, snapshotPayload: string): void {
    const deviceId = this.getDeviceId()
    if (!deviceId) {
      log.warn('No device ID available, skipping inbox sync enqueue for delete')
      return
    }

    try {
      const payload = this.withIncrementedClock(snapshotPayload, deviceId)
      this.queue.enqueue({
        type: 'inbox',
        itemId,
        operation: 'delete',
        payload,
        priority: 0
      })
    } catch (err) {
      log.error('Failed to enqueue inbox delete', err)
    }
  }

  private enqueue(itemId: string, operation: 'create' | 'update'): void {
    const deviceId = this.getDeviceId()
    if (!deviceId) {
      log.warn('No device ID available, skipping inbox sync enqueue')
      return
    }

    try {
      const item = this.db.select().from(inboxItems).where(eq(inboxItems.id, itemId)).get()
      if (!item) {
        log.warn('Inbox item not found for sync enqueue', { itemId })
        return
      }

      if (item.localOnly) return

      const existingClock = (item.clock as VectorClock) ?? {}
      const newClock = increment(existingClock, deviceId)

      this.db.update(inboxItems).set({ clock: newClock }).where(eq(inboxItems.id, itemId)).run()

      const payload = JSON.stringify({ ...item, clock: newClock })

      this.queue.enqueue({
        type: 'inbox',
        itemId,
        operation,
        payload,
        priority: 0
      })
    } catch (err) {
      log.error(`Failed to enqueue inbox ${operation}`, err)
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
