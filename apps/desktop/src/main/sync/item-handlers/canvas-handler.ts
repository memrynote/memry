import { and, eq, isNull } from 'drizzle-orm'
import { canvases, canvasEntityRefs, type CanvasRow } from '@memry/db-schema/data-schema'
import { CanvasSyncPayloadSchema, type CanvasSyncPayload } from '@memry/contracts/sync-payloads'
import { CanvasChannels } from '@memry/contracts/ipc-channels'
import type { VectorClock } from '@memry/contracts/sync-api'
import type { SyncQueueManager } from '../queue'
import { increment } from '../vector-clock'
import { createLogger } from '../../lib/logger'
import { generateId } from '../../lib/id'
import { encryptCanvasSceneForVault, decryptCanvasSceneForVault } from '../../canvas/encryption'
import { extractEntityRefsFromScene } from '../../canvas/scene-refs'
import { getCanvasSyncService } from '../canvas-sync'
import { trackMainEvent } from '../../telemetry/track'
import { BaseItemHandler } from './base-handler'
import type { ApplyContext, ApplyResult, DrizzleDb } from './types'

const log = createLogger('CanvasHandler')

type CanvasTx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0]

function writeRefs(tx: CanvasTx, canvasId: string, scene: string): void {
  for (const ref of extractEntityRefsFromScene(scene)) {
    tx.insert(canvasEntityRefs)
      .values({ canvasId, entityType: ref.entityType, entityId: ref.entityId })
      .onConflictDoNothing()
      .run()
  }
}

/**
 * `canvas` record sync handler (whole-doc LWW + hand-built conflict copy).
 *
 * See docs/superpowers/specs/2026-07-17-spatial-canvas-design.md §5 and §18
 * D1–D8. Key behaviours:
 * - The scene is re-encrypted at rest under the vault key (`snapshotCiphertext`)
 *   on apply, and decrypted fresh on push (`buildPushPayload`).
 * - D5: a payload without a `scene` never clobbers local ink — it is skipped.
 * - §5.4/D4: a concurrent clock hand-builds a conflict-copy row (new id, fresh
 *   clock, duplicated snapshot + refs, enqueued for push) BEFORE the LWW
 *   overwrite, so no ink is lost.
 * - D3: deletes are soft tombstones; refs are pruned in the same tx.
 * - D4: advisory `canvas_entity_refs` are rebuilt from the incoming scene.
 */
export class CanvasHandler extends BaseItemHandler<CanvasSyncPayload> {
  readonly type = 'canvas' as const
  readonly schema = CanvasSyncPayloadSchema

  applyUpsert(
    ctx: ApplyContext,
    itemId: string,
    data: CanvasSyncPayload,
    clock: VectorClock
  ): ApplyResult {
    const vaultKey = ctx.vaultKey
    if (!vaultKey) {
      log.warn('Skipping canvas apply without vault key', { itemId })
      return 'skipped'
    }

    // D5: the payload is all-optional for forward tolerance; a missing scene
    // must never overwrite good local ink under LWW. Validate presence here (the
    // use site), not in the schema.
    if (typeof data.scene !== 'string') {
      log.warn('Skipping canvas apply without scene', { itemId })
      return 'skipped'
    }
    const scene = data.scene

    return ctx.db.transaction((tx): ApplyResult => {
      const existing = tx.select().from(canvases).where(eq(canvases.id, itemId)).get()
      const remoteClock = Object.keys(clock).length > 0 ? clock : (data.clock ?? {})
      const now = Date.now()

      if (!existing) {
        const vaultId = data.vaultId
        if (!vaultId) {
          log.warn('Skipping canvas create without vaultId', { itemId })
          return 'skipped'
        }
        tx.insert(canvases)
          .values({
            id: itemId,
            vaultId,
            title: data.title ?? null,
            snapshotCiphertext: encryptCanvasSceneForVault(scene, vaultKey),
            vectorClock: {},
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
            lastSyncedAt: now,
            clock: remoteClock
          })
          .run()
        writeRefs(tx, itemId, scene)
        ctx.emit(CanvasChannels.events.CREATED, {
          canvas: { id: itemId, title: data.title ?? null, createdAt: now, updatedAt: now }
        })
        return 'applied'
      }

      const resolution = this.resolveClock(existing.clock, remoteClock)
      if (resolution.action === 'skip') {
        log.info('Skipping remote canvas update, local is newer', { itemId })
        return 'skipped'
      }

      // A conflict copy is only warranted by a genuine SCENE divergence. Identical
      // scenes under concurrent clocks (common once a never-rebound `_offline` tick
      // pollutes a clock) must NOT spawn spurious duplicate "(conflict copy)" rows
      // on every remote edit — compare the decrypted scenes before minting one.
      let madeCopy = false
      if (resolution.action === 'merge') {
        const localScene = decryptCanvasSceneForVault(existing.snapshotCiphertext, vaultKey)
        if (localScene !== scene) {
          // §5.4/D4: hand-build a conflict copy of the LOSING local snapshot BEFORE
          // overwriting, so no ink is lost.
          this.createConflictCopy(tx, ctx, existing, localScene, now)
          madeCopy = true
        }
      }

      // Preserve an explicit title clear (null): `?? existing.title` would treat a
      // deliberate null the same as an absent field and never propagate the clear.
      const nextTitle = data.title !== undefined ? data.title : existing.title

      tx.update(canvases)
        .set({
          title: nextTitle,
          snapshotCiphertext: encryptCanvasSceneForVault(scene, vaultKey),
          clock: resolution.mergedClock,
          updatedAt: now,
          // An incoming edit means the canvas is alive on the authoring device:
          // clear any local tombstone (delete-loses-to-concurrent-edit, R13/D2).
          // For a live canvas this is a no-op. Tombstones arrive via applyDelete,
          // never via a payload `deletedAt` (D3).
          deletedAt: null,
          lastSyncedAt: now
        })
        .where(eq(canvases.id, itemId))
        .run()

      // D4: rebuild advisory refs from the incoming scene.
      tx.delete(canvasEntityRefs).where(eq(canvasEntityRefs.canvasId, itemId)).run()
      writeRefs(tx, itemId, scene)

      ctx.emit(CanvasChannels.events.UPDATED, {
        canvas: { id: itemId, title: nextTitle, createdAt: existing.createdAt, updatedAt: now }
      })
      return madeCopy ? 'conflict' : 'applied'
    })
  }

  applyDelete(ctx: ApplyContext, itemId: string, clock?: VectorClock): 'applied' | 'skipped' {
    return ctx.db.transaction((tx): 'applied' | 'skipped' => {
      const existing = tx.select().from(canvases).where(eq(canvases.id, itemId)).get()
      if (!existing || existing.deletedAt !== null) return 'skipped'

      let nextClock: VectorClock = existing.clock ?? {}
      if (clock) {
        const resolution = this.resolveClock(existing.clock ?? {}, clock)
        // Concurrent or older delete loses to local edits (R13/D2): skip so the
        // canvas survives; a later delete with a dominating clock wins.
        if (resolution.action === 'skip' || resolution.action === 'merge') {
          log.info('Skipping remote canvas delete, local has unseen changes', { itemId })
          return 'skipped'
        }
        // Persist the delete's clock on the tombstone (mirrors the local-delete
        // path's buildDeletePayload bump). Otherwise the tombstone keeps a stale
        // pre-delete clock and a later concurrent edit resolves differently across
        // devices → split-brain resurrection.
        nextClock = resolution.mergedClock
      }

      const now = Date.now()
      tx.update(canvases)
        .set({ deletedAt: now, updatedAt: now, lastSyncedAt: now, clock: nextClock })
        .where(eq(canvases.id, itemId))
        .run()
      // D3: prune advisory refs in the same tx (FK cascade is dead code under a
      // soft delete).
      tx.delete(canvasEntityRefs).where(eq(canvasEntityRefs.canvasId, itemId)).run()
      ctx.emit(CanvasChannels.events.DELETED, { id: itemId })
      return 'applied'
    })
  }

  fetchLocal(db: DrizzleDb, itemId: string): Record<string, unknown> | undefined {
    return db.select().from(canvases).where(eq(canvases.id, itemId)).get() as
      | Record<string, unknown>
      | undefined
  }

  buildPushPayload(
    db: DrizzleDb,
    itemId: string,
    _deviceId: string,
    _operation: string,
    vaultKey?: Uint8Array
  ): string | null {
    if (!vaultKey) return null
    const row = db.select().from(canvases).where(eq(canvases.id, itemId)).get()
    if (!row) return null
    return JSON.stringify({
      id: row.id,
      vaultId: row.vaultId,
      title: row.title,
      scene: decryptCanvasSceneForVault(row.snapshotCiphertext, vaultKey),
      clock: row.clock ?? {},
      deletedAt: row.deletedAt ?? null
    })
  }

  markPushSynced(db: DrizzleDb, itemId: string): void {
    db.update(canvases).set({ lastSyncedAt: Date.now() }).where(eq(canvases.id, itemId)).run()
  }

  seedUnclocked(db: DrizzleDb, deviceId: string, queue: SyncQueueManager): number {
    // D2/D7: seed canvases created before the canvas sync type shipped (clock
    // NULL) so they reach other devices. Skip tombstones — seeding a soft-deleted
    // canvas as a create would resurrect it fleet-wide.
    const rows = db
      .select()
      .from(canvases)
      .where(and(isNull(canvases.clock), isNull(canvases.deletedAt)))
      .all()
    for (const row of rows) {
      const clock = increment({}, deviceId)
      db.update(canvases).set({ clock }).where(eq(canvases.id, row.id)).run()
      queue.enqueue({
        type: 'canvas',
        itemId: row.id,
        operation: 'create',
        // Metadata-only fallback; buildPushPayload rebuilds the scene with the
        // vault key at push time.
        payload: JSON.stringify({
          id: row.id,
          vaultId: row.vaultId,
          title: row.title,
          clock,
          deletedAt: null
        }),
        priority: 0
      })
    }
    return rows.length
  }

  private createConflictCopy(
    tx: CanvasTx,
    ctx: ApplyContext,
    existing: CanvasRow,
    localScene: string,
    now: number
  ): void {
    const service = getCanvasSyncService()
    const deviceId = service?.getDeviceId() ?? null

    const copyId = generateId()
    // If sync isn't running (no device id) we still PRESERVE the losing ink on
    // disk with a null clock, so `seedUnclocked` pushes it on the next engine
    // init. Never silently drop the losing snapshot.
    const copyClock = deviceId ? increment({}, deviceId) : null
    const copyTitle = `${existing.title ?? 'Canvas'} (conflict copy)`

    tx.insert(canvases)
      .values({
        id: copyId,
        vaultId: existing.vaultId,
        title: copyTitle,
        // Duplicate the LOSING local snapshot verbatim — no re-encrypt needed.
        snapshotCiphertext: existing.snapshotCiphertext,
        vectorClock: {},
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        lastSyncedAt: null,
        clock: copyClock
      })
      .run()

    // Rebuild advisory refs for the copy from the LOSING local scene (D4) —
    // derived from the scene itself, not the refs table, so the copy is correct
    // even if the table was never populated for this row.
    writeRefs(tx, copyId, localScene)

    if (deviceId) {
      // Enqueue a METADATA-ONLY create push (no plaintext scene at rest in the
      // sync queue — buildPushPayload rebuilds the scene from the copy row with
      // the vault key at push time). Enqueue-inside-apply-tx is safe (D1).
      service?.enqueueConflictCopyPush(
        copyId,
        JSON.stringify({
          id: copyId,
          vaultId: existing.vaultId,
          title: copyTitle,
          clock: copyClock,
          deletedAt: null
        })
      )
    } else {
      log.warn('Canvas conflict copy created without device id; will seed on next sync', {
        id: copyId
      })
    }

    ctx.emit(CanvasChannels.events.CREATED, {
      canvas: { id: copyId, title: copyTitle, createdAt: now, updatedAt: now }
    })
    trackMainEvent('canvas_sync_conflict_copy', {
      surface: 'sync',
      action: 'conflict_copy_created',
      objectType: 'canvas'
    })
  }
}

export const canvasHandler = new CanvasHandler()
