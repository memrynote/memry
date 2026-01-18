/**
 * Sync Service
 *
 * Handles sync operations: push, pull, manifest, and blob management.
 * Uses D1 for metadata and R2 for encrypted blobs.
 *
 * @module services/sync
 */

import { nanoid } from 'nanoid'
import type { Env } from '../index'
import { NotFoundError, ConflictError, ValidationError } from '../lib/errors'

// =============================================================================
// Types
// =============================================================================

/** Sync item types */
export type SyncItemType =
  | 'note'
  | 'task'
  | 'project'
  | 'settings'
  | 'attachment'
  | 'inbox_item'
  | 'saved_filter'

/** Sync operations */
export type SyncOperation = 'create' | 'update' | 'delete'

/** Vector clock type */
export interface VectorClock {
  [deviceId: string]: number
}

/** Sync item from database */
export interface SyncItem {
  id: string
  user_id: string
  type: SyncItemType
  operation: SyncOperation
  blob_key: string
  size: number
  version: number
  state_vector: string | null
  clock: string | null
  created_at: number
  modified_at: number
  deleted_at: number | null
}

/** Item for push request */
export interface SyncPushItem {
  id: string
  type: SyncItemType
  operation: SyncOperation
  encryptedData: string
  signature: string
  clock?: VectorClock
  stateVector?: string
}

/** Item in pull response */
export interface SyncPullItem {
  id: string
  type: SyncItemType
  operation: SyncOperation
  version: number
  encryptedData: string
  signature: string
  clock?: VectorClock
  stateVector?: string
  modifiedAt: number
  deletedAt?: number
}

/** Conflict information */
export interface SyncConflict {
  id: string
  type: SyncItemType
  serverVersion: number
  serverClock: VectorClock
}

/** Manifest item (metadata only) */
export interface ManifestItem {
  id: string
  type: SyncItemType
  version: number
  size: number
  modifiedAt: number
  deletedAt?: number
}

// =============================================================================
// Sync Service Class
// =============================================================================

/**
 * Sync Service
 *
 * Manages sync operations between clients and the server.
 */
export class SyncService {
  constructor(
    private db: D1Database,
    private bucket: R2Bucket
  ) {}

  // ---------------------------------------------------------------------------
  // Manifest Operations
  // ---------------------------------------------------------------------------

  /**
   * Get manifest of all items for a user.
   *
   * Returns metadata (no encrypted content) for all items.
   *
   * @param userId - User ID
   * @returns Array of manifest items
   */
  async getManifest(userId: string): Promise<ManifestItem[]> {
    const result = await this.db
      .prepare(
        `SELECT id, type, version, size, modified_at, deleted_at
         FROM sync_items
         WHERE user_id = ?
         ORDER BY modified_at DESC`
      )
      .bind(userId)
      .all<{
        id: string
        type: SyncItemType
        version: number
        size: number
        modified_at: number
        deleted_at: number | null
      }>()

    return (result.results ?? []).map((item) => ({
      id: item.id,
      type: item.type,
      version: item.version,
      size: item.size,
      modifiedAt: item.modified_at,
      deletedAt: item.deleted_at ?? undefined
    }))
  }

  /**
   * Get changes since a given timestamp.
   *
   * @param userId - User ID
   * @param since - Unix timestamp (ms) to get changes since
   * @param limit - Maximum number of items to return
   * @returns Array of manifest items
   */
  async getChanges(
    userId: string,
    since: number,
    limit: number = 100
  ): Promise<{ items: ManifestItem[]; hasMore: boolean }> {
    const result = await this.db
      .prepare(
        `SELECT id, type, version, size, modified_at, deleted_at
         FROM sync_items
         WHERE user_id = ? AND modified_at > ?
         ORDER BY modified_at ASC
         LIMIT ?`
      )
      .bind(userId, since, limit + 1)
      .all<{
        id: string
        type: SyncItemType
        version: number
        size: number
        modified_at: number
        deleted_at: number | null
      }>()

    const items = result.results ?? []
    const hasMore = items.length > limit

    return {
      items: items.slice(0, limit).map((item) => ({
        id: item.id,
        type: item.type,
        version: item.version,
        size: item.size,
        modifiedAt: item.modified_at,
        deletedAt: item.deleted_at ?? undefined
      })),
      hasMore
    }
  }

  // ---------------------------------------------------------------------------
  // Push Operations
  // ---------------------------------------------------------------------------

  /**
   * Push items from a client.
   *
   * @param userId - User ID
   * @param items - Items to push
   * @param deviceClock - Client's device clock
   * @returns Push result with accepted items and conflicts
   */
  async pushItems(
    userId: string,
    items: SyncPushItem[],
    deviceClock: VectorClock
  ): Promise<{
    accepted: string[]
    conflicts: SyncConflict[]
    serverClock: VectorClock
  }> {
    const accepted: string[] = []
    const conflicts: SyncConflict[] = []
    let serverClock: VectorClock = {}

    for (const item of items) {
      try {
        const result = await this.pushSingleItem(userId, item, deviceClock)

        if (result.conflict) {
          conflicts.push(result.conflict)
        } else {
          accepted.push(item.id)
        }

        // Merge clocks
        serverClock = this.mergeClock(serverClock, result.clock)
      } catch (error) {
        // Log error but continue with other items
        console.error(`Failed to push item ${item.id}:`, error)
      }
    }

    return { accepted, conflicts, serverClock }
  }

  /**
   * Push a single item.
   */
  private async pushSingleItem(
    userId: string,
    item: SyncPushItem,
    clientClock: VectorClock
  ): Promise<{ conflict?: SyncConflict; clock: VectorClock }> {
    const now = Date.now()

    // Check for existing item
    const existing = await this.db
      .prepare(
        'SELECT id, version, clock, modified_at FROM sync_items WHERE id = ? AND user_id = ?'
      )
      .bind(item.id, userId)
      .first<{ id: string; version: number; clock: string | null; modified_at: number }>()

    // Handle delete operation
    if (item.operation === 'delete') {
      if (existing) {
        // Soft delete
        await this.db
          .prepare(
            'UPDATE sync_items SET deleted_at = ?, modified_at = ?, version = version + 1 WHERE id = ?'
          )
          .bind(now, now, item.id)
          .run()

        // Note: We keep the blob for potential restore
      }

      return { clock: item.clock ?? {} }
    }

    // Check for conflict
    if (existing && item.operation === 'update') {
      const serverClock = existing.clock ? JSON.parse(existing.clock) : {}
      const comparison = this.compareClock(clientClock, serverClock)

      if (comparison === 'concurrent') {
        // Conflict detected
        return {
          conflict: {
            id: item.id,
            type: item.type,
            serverVersion: existing.version,
            serverClock
          },
          clock: serverClock
        }
      }
    }

    // Store encrypted blob in R2
    const blobKey = `${userId}/${item.type}/${item.id}`
    await this.bucket.put(blobKey, item.encryptedData, {
      customMetadata: {
        signature: item.signature,
        stateVector: item.stateVector ?? ''
      }
    })

    const size = new Blob([item.encryptedData]).size

    // Update or insert metadata in D1
    if (existing) {
      await this.db
        .prepare(
          `UPDATE sync_items
           SET blob_key = ?, size = ?, version = version + 1, operation = ?, clock = ?, state_vector = ?, modified_at = ?, deleted_at = NULL
           WHERE id = ?`
        )
        .bind(
          blobKey,
          size,
          item.operation,
          JSON.stringify(item.clock ?? {}),
          item.stateVector ?? null,
          now,
          item.id
        )
        .run()
    } else {
      await this.db
        .prepare(
          `INSERT INTO sync_items (id, user_id, type, operation, blob_key, size, version, clock, state_vector, created_at, modified_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
        )
        .bind(
          item.id,
          userId,
          item.type,
          item.operation,
          blobKey,
          size,
          JSON.stringify(item.clock ?? {}),
          item.stateVector ?? null,
          now,
          now
        )
        .run()
    }

    return { clock: item.clock ?? {} }
  }

  // ---------------------------------------------------------------------------
  // Pull Operations
  // ---------------------------------------------------------------------------

  /**
   * Pull items for a client.
   *
   * @param userId - User ID
   * @param since - Optional timestamp to get changes since
   * @param types - Optional filter by item types
   * @param limit - Maximum number of items to return
   * @returns Pull result with items
   */
  async pullItems(
    userId: string,
    since?: number,
    types?: SyncItemType[],
    limit: number = 100
  ): Promise<{
    items: SyncPullItem[]
    hasMore: boolean
    serverClock: VectorClock
    serverTimestamp: number
  }> {
    // Build query
    let query = 'SELECT * FROM sync_items WHERE user_id = ?'
    const params: (string | number)[] = [userId]

    if (since) {
      query += ' AND modified_at > ?'
      params.push(since)
    }

    if (types && types.length > 0) {
      query += ` AND type IN (${types.map(() => '?').join(', ')})`
      params.push(...types)
    }

    query += ' ORDER BY modified_at ASC LIMIT ?'
    params.push(limit + 1)

    const result = await this.db
      .prepare(query)
      .bind(...params)
      .all<SyncItem>()

    const items = result.results ?? []
    const hasMore = items.length > limit
    const returnItems = items.slice(0, limit)

    // Fetch encrypted data from R2 and build response
    const pullItems: SyncPullItem[] = []
    let serverClock: VectorClock = {}

    for (const item of returnItems) {
      const blob = await this.bucket.get(item.blob_key)

      if (blob) {
        const encryptedData = await blob.text()
        const signature = blob.customMetadata?.signature ?? ''

        pullItems.push({
          id: item.id,
          type: item.type,
          operation: item.operation,
          version: item.version,
          encryptedData,
          signature,
          clock: item.clock ? JSON.parse(item.clock) : undefined,
          stateVector: item.state_vector ?? undefined,
          modifiedAt: item.modified_at,
          deletedAt: item.deleted_at ?? undefined
        })

        // Merge clock
        if (item.clock) {
          serverClock = this.mergeClock(serverClock, JSON.parse(item.clock))
        }
      }
    }

    return {
      items: pullItems,
      hasMore,
      serverClock,
      serverTimestamp: Date.now()
    }
  }

  /**
   * Get a specific item by ID.
   *
   * @param userId - User ID
   * @param itemId - Item ID
   * @returns Item with encrypted data
   */
  async getItem(userId: string, itemId: string): Promise<SyncPullItem | null> {
    const item = await this.db
      .prepare('SELECT * FROM sync_items WHERE id = ? AND user_id = ?')
      .bind(itemId, userId)
      .first<SyncItem>()

    if (!item) {
      return null
    }

    const blob = await this.bucket.get(item.blob_key)
    if (!blob) {
      return null
    }

    const encryptedData = await blob.text()
    const signature = blob.customMetadata?.signature ?? ''

    return {
      id: item.id,
      type: item.type,
      operation: item.operation,
      version: item.version,
      encryptedData,
      signature,
      clock: item.clock ? JSON.parse(item.clock) : undefined,
      stateVector: item.state_vector ?? undefined,
      modifiedAt: item.modified_at,
      deletedAt: item.deleted_at ?? undefined
    }
  }

  // ---------------------------------------------------------------------------
  // Delete Operations
  // ---------------------------------------------------------------------------

  /**
   * Soft delete an item.
   *
   * @param userId - User ID
   * @param itemId - Item ID
   * @returns True if deleted
   */
  async deleteItem(userId: string, itemId: string): Promise<boolean> {
    const now = Date.now()

    const result = await this.db
      .prepare(
        'UPDATE sync_items SET deleted_at = ?, modified_at = ?, version = version + 1 WHERE id = ? AND user_id = ?'
      )
      .bind(now, now, itemId, userId)
      .run()

    return (result.meta?.changes ?? 0) > 0
  }

  /**
   * Permanently delete an item and its blob.
   *
   * @param userId - User ID
   * @param itemId - Item ID
   */
  async permanentlyDeleteItem(userId: string, itemId: string): Promise<void> {
    const item = await this.db
      .prepare('SELECT blob_key FROM sync_items WHERE id = ? AND user_id = ?')
      .bind(itemId, userId)
      .first<{ blob_key: string }>()

    if (item) {
      // Delete blob from R2
      await this.bucket.delete(item.blob_key)

      // Delete metadata from D1
      await this.db
        .prepare('DELETE FROM sync_items WHERE id = ? AND user_id = ?')
        .bind(itemId, userId)
        .run()
    }
  }

  // ---------------------------------------------------------------------------
  // Vector Clock Operations
  // ---------------------------------------------------------------------------

  /**
   * Merge two vector clocks.
   */
  private mergeClock(a: VectorClock, b: VectorClock): VectorClock {
    const merged: VectorClock = { ...a }

    for (const [device, time] of Object.entries(b)) {
      merged[device] = Math.max(merged[device] ?? 0, time)
    }

    return merged
  }

  /**
   * Compare two vector clocks.
   *
   * @returns 'before' if a < b, 'after' if a > b, 'equal' if a == b, 'concurrent' if neither
   */
  private compareClock(
    a: VectorClock,
    b: VectorClock
  ): 'before' | 'after' | 'equal' | 'concurrent' {
    const allDevices = new Set([...Object.keys(a), ...Object.keys(b)])

    let aLessOrEqual = true
    let bLessOrEqual = true

    for (const device of allDevices) {
      const timeA = a[device] ?? 0
      const timeB = b[device] ?? 0

      if (timeA > timeB) {
        bLessOrEqual = false
      }
      if (timeB > timeA) {
        aLessOrEqual = false
      }
    }

    if (aLessOrEqual && bLessOrEqual) {
      return 'equal'
    }
    if (aLessOrEqual) {
      return 'before'
    }
    if (bLessOrEqual) {
      return 'after'
    }

    return 'concurrent'
  }

  // ---------------------------------------------------------------------------
  // Storage Operations
  // ---------------------------------------------------------------------------

  /**
   * Get storage usage for a user.
   *
   * @param userId - User ID
   * @returns Total bytes used
   */
  async getStorageUsage(userId: string): Promise<number> {
    const result = await this.db
      .prepare('SELECT SUM(size) as total FROM sync_items WHERE user_id = ? AND deleted_at IS NULL')
      .bind(userId)
      .first<{ total: number | null }>()

    return result?.total ?? 0
  }

  /**
   * Update user's storage usage.
   *
   * @param userId - User ID
   * @param usage - New storage usage in bytes
   */
  async updateStorageUsage(userId: string, usage: number): Promise<void> {
    await this.db
      .prepare('UPDATE users SET storage_used = ?, updated_at = ? WHERE id = ?')
      .bind(usage, Date.now(), userId)
      .run()
  }

  // ---------------------------------------------------------------------------
  // Cleanup Operations
  // ---------------------------------------------------------------------------

  /**
   * Clean up old deleted items (tombstones).
   *
   * @param userId - User ID
   * @param olderThan - Delete tombstones older than this timestamp
   * @returns Number of items cleaned up
   */
  async cleanupTombstones(userId: string, olderThan: number): Promise<number> {
    // Get items to delete
    const items = await this.db
      .prepare(
        'SELECT id, blob_key FROM sync_items WHERE user_id = ? AND deleted_at IS NOT NULL AND deleted_at < ?'
      )
      .bind(userId, olderThan)
      .all<{ id: string; blob_key: string }>()

    // Delete blobs from R2
    for (const item of items.results ?? []) {
      await this.bucket.delete(item.blob_key)
    }

    // Delete metadata from D1
    const result = await this.db
      .prepare(
        'DELETE FROM sync_items WHERE user_id = ? AND deleted_at IS NOT NULL AND deleted_at < ?'
      )
      .bind(userId, olderThan)
      .run()

    return result.meta?.changes ?? 0
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a SyncService instance.
 *
 * @param env - Cloudflare environment bindings
 * @returns SyncService instance
 */
export function createSyncService(env: Env): SyncService {
  return new SyncService(env.DB, env.BLOB_BUCKET)
}
