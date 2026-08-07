import { and, eq, isNull } from 'drizzle-orm'
import { canvasFolders, type CanvasFolderRow } from '@memry/db-schema/data-schema'
import {
  CanvasFolderSyncPayloadSchema,
  type CanvasFolderSyncPayload
} from '@memry/contracts/sync-payloads'
import { CanvasFolderChannels } from '@memry/contracts/ipc-channels'
import type { VectorClock } from '@memry/contracts/sync-api'
import type { SyncQueueManager } from '../queue'
import { increment } from '../vector-clock'
import { createLogger } from '../../lib/logger'
import { removeEmptyCanvasFolderDirs } from '../../canvas/scene-file'
import { getCanvasVaultPath } from '../../canvas/vault-path'
import { BaseItemHandler } from './base-handler'
import type { ApplyContext, ApplyResult, DrizzleDb } from './types'

const log = createLogger('CanvasFolderHandler')

/**
 * The wire shape for a folder row. Built explicitly rather than serializing the
 * row so device-local bookkeeping (`syncedAt`) never leaves this machine.
 */
function toPayload(row: CanvasFolderRow, clock: VectorClock | null): CanvasFolderSyncPayload {
  return {
    id: row.id,
    vaultId: row.vaultId,
    path: row.path,
    icon: row.icon ?? null,
    clock: clock ?? undefined,
    deletedAt: row.deletedAt ?? null
  }
}

/**
 * `canvas_folder` record sync handler — whole-row LWW over a folder's existence
 * and its icon. Placement of a canvas lives on the `canvases` row, so this type
 * carries only what the directory itself cannot: the icon, and the existence of
 * an EMPTY folder.
 *
 * Two deliberate departures from the `filter` template it is modelled on:
 * - **Timestamps are `Date.now()` epoch ms**, not `utcNow()` ISO strings —
 *   `canvas_folders` matches `canvases`, and mixing the two corrupts every
 *   comparison downstream.
 * - **`applyDelete` soft-deletes.** `filter` drops the row; a canvas folder must
 *   stay visible to sync, or the tombstone is invisible to the next pull and the
 *   folder resurrects. `fetchLocal` and `seedUnclocked` therefore filter
 *   `deletedAt IS NULL`.
 */
class CanvasFolderHandler extends BaseItemHandler<CanvasFolderSyncPayload> {
  readonly type = 'canvas_folder' as const
  readonly schema = CanvasFolderSyncPayloadSchema

  applyUpsert(
    ctx: ApplyContext,
    itemId: string,
    data: CanvasFolderSyncPayload,
    clock: VectorClock
  ): ApplyResult {
    return ctx.db.transaction((tx): ApplyResult => {
      const existing = tx.select().from(canvasFolders).where(eq(canvasFolders.id, itemId)).get()
      const remoteClock = Object.keys(clock).length > 0 ? clock : (data.clock ?? {})
      const now = Date.now()

      if (existing) {
        const resolution = this.resolveClock(existing.clock, remoteClock)
        if (resolution.action === 'skip') {
          log.info('Skipping remote canvas folder update, local is newer', { itemId })
          return 'skipped'
        }
        if (resolution.action === 'merge') {
          log.warn('Concurrent canvas folder edit, using last-write-wins', { itemId })
        }

        const next = {
          path: data.path ?? existing.path,
          // An explicit null is the user CLEARING the icon; `?? existing.icon`
          // would read that as "absent" and never propagate the clear.
          icon: data.icon !== undefined ? data.icon : existing.icon,
          deletedAt: data.deletedAt ?? null
        }
        tx.update(canvasFolders)
          .set({
            ...next,
            clock: resolution.mergedClock,
            updatedAt: now,
            syncedAt: now
          })
          .where(eq(canvasFolders.id, itemId))
          .run()

        ctx.emit(CanvasFolderChannels.events.UPDATED, {
          folder: {
            id: itemId,
            path: next.path,
            icon: next.icon ?? null,
            createdAt: existing.createdAt,
            updatedAt: now
          },
          previousPath: existing.path
        })
        return resolution.action === 'merge' ? 'conflict' : 'applied'
      }

      // Both columns are NOT NULL and the payload is all-optional for forward
      // tolerance, so presence is checked here (the use site) rather than in the
      // schema. A folder with no path is not a folder.
      const vaultId = data.vaultId
      const path = data.path
      if (!vaultId || !path) {
        log.warn('Skipping canvas folder create without vaultId or path', { itemId })
        return 'skipped'
      }

      tx.insert(canvasFolders)
        .values({
          id: itemId,
          vaultId,
          path,
          icon: data.icon ?? null,
          createdAt: now,
          updatedAt: now,
          deletedAt: data.deletedAt ?? null,
          clock: remoteClock,
          syncedAt: now
        })
        .run()

      ctx.emit(CanvasFolderChannels.events.CREATED, {
        folder: { id: itemId, path, icon: data.icon ?? null, createdAt: now, updatedAt: now }
      })
      return 'applied'
    })
  }

  applyDelete(ctx: ApplyContext, itemId: string, clock?: VectorClock): 'applied' | 'skipped' {
    const existing = ctx.db.select().from(canvasFolders).where(eq(canvasFolders.id, itemId)).get()
    if (!existing || existing.deletedAt !== null) return 'skipped'

    let nextClock: VectorClock = existing.clock ?? {}
    if (clock && existing.clock) {
      const resolution = this.resolveClock(existing.clock, clock)
      if (resolution.action === 'skip' || resolution.action === 'merge') {
        log.info('Skipping remote canvas folder delete, local has unseen changes', { itemId })
        return 'skipped'
      }
      // Persist the delete's clock on the tombstone, or it keeps a stale
      // pre-delete clock and a later edit resolves differently across devices.
      nextClock = resolution.mergedClock
    }

    const now = Date.now()
    ctx.db
      .update(canvasFolders)
      .set({ deletedAt: now, updatedAt: now, syncedAt: now, clock: nextClock })
      .where(eq(canvasFolders.id, itemId))
      .run()

    // Remove the directory too, the way `canvasHandler.applyDelete` removes the
    // document: a tombstoned folder must not keep haunting the user's vault.
    // Left behind, it is what the next reconcile finds and adopts back as a live
    // folder — the delete the user made on one device undone on all the others.
    //
    // Only EMPTY directories go (see `removeEmptyCanvasFolderDirs`). The canvas
    // files are removed one at a time by their own deletes, and one that failed
    // (a locked file, a refused trash) has left ink behind that is not this
    // handler's to take. After the tombstone and outside any transaction: an fs
    // failure must never roll back — and thereby resurrect — the delete.
    const vaultPath = getCanvasVaultPath()
    if (vaultPath) removeEmptyCanvasFolderDirs(vaultPath, existing.path)

    ctx.emit(CanvasFolderChannels.events.DELETED, { path: existing.path })
    return 'applied'
  }

  fetchLocal(db: DrizzleDb, itemId: string): Record<string, unknown> | undefined {
    return db
      .select()
      .from(canvasFolders)
      .where(and(eq(canvasFolders.id, itemId), isNull(canvasFolders.deletedAt)))
      .get() as Record<string, unknown> | undefined
  }

  buildPushPayload(
    db: DrizzleDb,
    itemId: string,
    _deviceId: string,
    _operation: string
  ): string | null {
    const row = db.select().from(canvasFolders).where(eq(canvasFolders.id, itemId)).get()
    if (!row) return null
    return JSON.stringify(toPayload(row, row.clock))
  }

  markPushSynced(db: DrizzleDb, itemId: string): void {
    db.update(canvasFolders).set({ syncedAt: Date.now() }).where(eq(canvasFolders.id, itemId)).run()
  }

  seedUnclocked(db: DrizzleDb, deviceId: string, queue: SyncQueueManager): number {
    // Tombstones are skipped: seeding a soft-deleted folder as a create would
    // resurrect it fleet-wide.
    const rows = db
      .select()
      .from(canvasFolders)
      .where(and(isNull(canvasFolders.clock), isNull(canvasFolders.deletedAt)))
      .all()
    for (const row of rows) {
      const clock = increment({}, deviceId)
      db.update(canvasFolders).set({ clock }).where(eq(canvasFolders.id, row.id)).run()
      queue.enqueue({
        type: 'canvas_folder',
        itemId: row.id,
        operation: 'create',
        payload: JSON.stringify(toPayload(row, clock)),
        priority: 0
      })
    }
    return rows.length
  }
}

export const canvasFolderHandler = new CanvasFolderHandler()
