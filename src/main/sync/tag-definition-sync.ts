import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import type * as schema from '@shared/db/schema/data-schema'
import { tagDefinitions } from '@shared/db/schema/tag-definitions'
import type { VectorClock } from '@shared/contracts/sync-api'
import type { SyncQueueManager } from './queue'
import { increment } from './vector-clock'
import { createLogger } from '../lib/logger'

type DrizzleDb = BetterSQLite3Database<typeof schema>

const log = createLogger('TagDefinitionSync')

interface TagDefinitionSyncDeps {
  queue: SyncQueueManager
  db: DrizzleDb
  getDeviceId: () => string | null
}

let instance: TagDefinitionSyncService | null = null

export function initTagDefinitionSyncService(
  deps: TagDefinitionSyncDeps
): TagDefinitionSyncService {
  instance = new TagDefinitionSyncService(deps)
  return instance
}

export function getTagDefinitionSyncService(): TagDefinitionSyncService | null {
  return instance
}

export function resetTagDefinitionSyncService(): void {
  instance = null
}

export class TagDefinitionSyncService {
  private queue: SyncQueueManager
  private db: DrizzleDb
  private getDeviceId: () => string | null

  constructor(deps: TagDefinitionSyncDeps) {
    this.queue = deps.queue
    this.db = deps.db
    this.getDeviceId = deps.getDeviceId
  }

  enqueueCreate(name: string): void {
    this.enqueue(name, 'create')
  }

  enqueueUpdate(name: string): void {
    this.enqueue(name, 'update')
  }

  enqueueDelete(name: string, snapshotPayload?: string): void {
    const deviceId = this.getDeviceId()
    if (!deviceId) {
      log.warn('No device ID available, skipping tag definition sync enqueue for delete')
      return
    }

    try {
      const payload = snapshotPayload
        ? this.withIncrementedClock(snapshotPayload, deviceId)
        : JSON.stringify({ name, color: '', clock: increment({}, deviceId) })

      this.queue.enqueue({
        type: 'tag_definition',
        itemId: name,
        operation: 'delete',
        payload,
        priority: 0
      })
    } catch (err) {
      log.error('Failed to enqueue tag definition delete', err)
    }
  }

  private enqueue(name: string, operation: 'create' | 'update'): void {
    const deviceId = this.getDeviceId()
    if (!deviceId) {
      log.warn('No device ID available, skipping tag definition sync enqueue')
      return
    }

    try {
      const tag = this.db.select().from(tagDefinitions).where(eq(tagDefinitions.name, name)).get()
      if (!tag) {
        log.warn('Tag definition not found for sync enqueue', { name })
        return
      }

      const existingClock = (tag.clock as VectorClock) ?? {}
      const newClock = increment(existingClock, deviceId)

      this.db
        .update(tagDefinitions)
        .set({ clock: newClock })
        .where(eq(tagDefinitions.name, name))
        .run()

      const payload = JSON.stringify({ ...tag, clock: newClock })

      this.queue.enqueue({
        type: 'tag_definition',
        itemId: name,
        operation,
        payload,
        priority: 0
      })
    } catch (err) {
      log.error(`Failed to enqueue tag definition ${operation}`, err)
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
