import { and, eq, isNull } from 'drizzle-orm'
import {
  canvasAssets,
  canvases,
  canvasEntityRefs,
  type CanvasRow
} from '@memry/db-schema/data-schema'
import { CanvasSyncPayloadSchema, type CanvasSyncPayload } from '@memry/contracts/sync-payloads'
import { CanvasChannels } from '@memry/contracts/ipc-channels'
import type { VectorClock } from '@memry/contracts/sync-api'
import type { SyncQueueManager } from '../queue'
import { increment } from '@memry/sync-client/vector-clock'
import { createLogger } from '../../lib/logger'
import { generateId } from '../../lib/id'
import {
  allocateCanvasPath,
  CANVAS_FILE_EXT,
  deleteCanvasFileSync,
  ensureCanvasFolderDir,
  folderOfCanvasPath,
  portableCanvasFolder,
  renameCanvasFile,
  resolveCanvasFile
} from '../../canvas/scene-file'
import { normalizeFolder } from '../../canvas/folder-paths'
import { readCanvasScene, writeCanvasScene } from '../../canvas/store'
import { getCanvasVaultPath } from '../../canvas/vault-path'
import { extractEntityRefsFromScene } from '../../canvas/scene-refs'
import { readMemryAssets } from '../../canvas/assets/memry-assets'
import { ensureAssetsPresent, reconcileCanvasAssets } from '../../canvas/assets/asset-service'
import { buildAssetServiceContext } from '../../canvas/assets/asset-service-context'
import { getCanvasSyncService } from '../canvas-sync'
import { trackMainEvent } from '../../telemetry/track'
import { trackMainLog } from '../../telemetry/diagnostics'
import { BaseItemHandler } from './base-handler'
import type { ApplyContext, ApplyResult, DrizzleDb } from './types'
import type { MemryAssetDescriptor } from '@memry/contracts/canvas-api'

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
 * M5: ingest the `memryAssets` scene sidecar into the per-device dedup/GC index
 * (`canvas_assets`). Records one idempotent row per (canvas, asset) so a
 * non-authoring device gets the dedup + GC bookkeeping it never uploaded, and
 * the GC union (`hashesReferencedByOtherCanvases`) protects assets shared across
 * canvases (incl. conflict copies). A pre-M5 / inline-base64 scene yields `[]`
 * → zero rows (backward compat). Writes through the apply transaction handle
 * (`tx`, like `writeRefs`), so it commits/rolls back atomically with the scene
 * + entity-ref writes.
 */
function recordSceneAssets(
  tx: CanvasTx,
  vaultId: string,
  canvasId: string,
  descriptors: MemryAssetDescriptor[]
): void {
  const now = Date.now()
  for (const descriptor of descriptors) {
    tx.insert(canvasAssets)
      .values({
        vaultId,
        canvasId,
        contentHash: descriptor.contentHash,
        attachmentId: descriptor.attachmentId,
        fileId: descriptor.fileId,
        filename: descriptor.filename,
        mimeType: descriptor.mimeType,
        sizeBytes: descriptor.sizeBytes,
        chunkHashes: descriptor.chunkHashes,
        createdAt: now
      })
      .onConflictDoNothing()
      .run()
  }
}

/**
 * M5 device-B restore: after the apply tx commits, download any asset file the
 * applied scene references but this device is missing, so the scene renders.
 * Fire-and-forget — a failed/slow download must never fail (or block) the apply,
 * and a closed vault (no asset context) is a silent no-op. `ensureAssetsPresent`
 * already isolates per-asset errors and calls `markWritebackIgnored` first.
 */
async function restoreCanvasAssets(
  canvasId: string,
  descriptors: MemryAssetDescriptor[]
): Promise<void> {
  try {
    const assetCtx = buildAssetServiceContext()
    if (!assetCtx) return
    await ensureAssetsPresent(assetCtx, canvasId, descriptors)
  } catch (err) {
    log.warn('canvas asset restore failed after apply', { canvasId, err })
  }
}

/**
 * M5 GC on remote delete: after the tombstone commits, reconcile the deleted
 * canvas against an empty scene so all of its hashes are candidates for removal.
 * The GC union still protects any hash a conflict copy / other canvas references,
 * so a shared asset survives. Fire-and-forget / graceful — GC must never fail a
 * delete, and a closed vault is a silent no-op.
 */
async function gcDeletedCanvasAssets(canvasId: string): Promise<void> {
  try {
    const assetCtx = buildAssetServiceContext()
    if (!assetCtx) return
    await reconcileCanvasAssets(assetCtx, canvasId, '')
  } catch (err) {
    log.warn('canvas asset GC failed after delete', { canvasId, err })
  }
}

/**
 * `canvas` record sync handler (whole-doc LWW + hand-built conflict copy).
 *
 * See docs/superpowers/specs/2026-07-17-spatial-canvas-design.md §5 and §18
 * D1–D8. Key behaviours:
 * - The scene is written to the canvas's `.excalidraw` file in the vault on
 *   apply, and read straight back off disk on push (`buildPushPayload`). No key
 *   material is involved at rest; the transport encryption in sync/encrypt.ts is
 *   unchanged, so the server still never sees plaintext.
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
    const vaultPath = getCanvasVaultPath()
    if (!vaultPath) {
      log.warn('Skipping canvas apply without an open vault', { itemId })
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
    // M5: assets externalized into the scene sidecar. `[]` for a pre-M5 /
    // inline-base64 scene → no rows recorded, no downloads triggered.
    const descriptors = readMemryAssets(scene)

    const result = ctx.db.transaction((tx): ApplyResult => {
      const existing = tx.select().from(canvases).where(eq(canvases.id, itemId)).get()
      const remoteClock = Object.keys(clock).length > 0 ? clock : (data.clock ?? {})
      const now = Date.now()

      if (!existing) {
        const vaultId = data.vaultId
        if (!vaultId) {
          log.warn('Skipping canvas create without vaultId', { itemId })
          return 'skipped'
        }
        // Placement: the directory has to exist before the scene is written, or
        // the write throws and the whole apply rolls back. A payload with no
        // folder is either the root or a pre-folders build — both land at the
        // root, which is where every canvas used to live.
        const folder = normalizeFolder(data.folder)
        if (folder) ensureCanvasFolderDir(vaultPath, folder)
        const filePath = allocateCanvasPath(vaultPath, data.title ?? null, new Set(), null, folder)
        writeCanvasScene(vaultPath, filePath, itemId, scene, now, now)
        tx.insert(canvases)
          .values({
            id: itemId,
            vaultId,
            title: data.title ?? null,
            filePath,
            // Read back out of the allocated path, never echoed from the
            // payload: `allocateCanvasPath` sanitizes each segment, so a folder
            // the peer called `CON` lives here as `CON canvas`. The STORED
            // folder is always the on-disk-canonical one.
            folder: folderOfCanvasPath(filePath),
            icon: data.icon ?? null,
            snapshotCiphertext: '',
            vectorClock: {},
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
            lastSyncedAt: now,
            clock: remoteClock
          })
          .run()
        writeRefs(tx, itemId, scene)
        // M5: ingest the asset sidecar so this device gets dedup/GC rows.
        recordSceneAssets(tx, vaultId, itemId, descriptors)
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
        const localScene = readCanvasScene(vaultPath, existing.filePath)
        if (localScene !== null && localScene !== scene) {
          // §5.4/D4: hand-build a conflict copy of the LOSING local snapshot BEFORE
          // overwriting, so no ink is lost.
          this.createConflictCopy(tx, ctx, vaultPath, existing, localScene, now)
          madeCopy = true
        }
      }

      // Preserve an explicit title clear (null): `?? existing.title` would treat a
      // deliberate null the same as an absent field and never propagate the clear.
      const nextTitle = data.title !== undefined ? data.title : existing.title

      // An absent `folder` is a pre-folders payload, not a move to the root:
      // keep whatever placement this device already has. The stored string stays
      // the on-disk-canonical form, so a peer's `CON` is filed as `CON canvas`
      // here too.
      const folderRequested = data.folder !== undefined
      // `?? null` only to keep the narrowing the hoisted flag costs us: inside
      // this branch `data.folder` is `string | null`, never undefined.
      const nextFolder = folderRequested
        ? portableCanvasFolder(data.folder ?? null)
        : existing.folder

      // A legacy row we could never decrypt has no file yet; the incoming scene
      // gives it one rather than writing into nowhere. The filename is NOT
      // re-derived from an incoming title: renaming files on every remote edit
      // would churn the user's folder (and their git history) for nothing.
      let filePath = existing.filePath
      if (!filePath) {
        if (nextFolder) ensureCanvasFolderDir(vaultPath, nextFolder)
        filePath = allocateCanvasPath(vaultPath, nextTitle, new Set(), null, nextFolder)
      } else if (folderRequested && nextFolder !== folderOfCanvasPath(filePath)) {
        // A remote MOVE. Both halves or neither: writing `folder` while the
        // document stays put leaves the row describing a path nothing occupies,
        // and every later placement operation works off that path — a folder
        // rename re-points it at a file that was never there (the canvas goes
        // unopenable AND silently unpushable, since `buildPushPayload` reads the
        // scene off `filePath`), and a folder delete cannot take a directory the
        // document never left, so the next reconcile finds it occupied and
        // revives a folder the user deleted. This mirrors `store.updateCanvas`,
        // the LOCAL half of the same operation.
        //
        // The FILENAME travels unchanged — only the directory changes — for the
        // same reason it is not re-derived from the title above. Routed through
        // `allocateCanvasPath` so a name already taken in the destination is
        // uniquified: `renameSync` replaces the target on every platform, and
        // that target is another canvas's ink.
        //
        // No ensure-the-directory step: `renameCanvasFile` mkdirs the target's
        // parent itself, and creating it up front would leave an empty directory
        // behind whenever the rename fails — a folder the next reconcile adopts
        // even though the canvas never got there.
        const base = filePath.slice(filePath.lastIndexOf('/') + 1, -CANVAS_FILE_EXT.length)
        const target = allocateCanvasPath(vaultPath, base, new Set(), filePath, nextFolder)
        filePath = renameCanvasFile(vaultPath, filePath, target)
      }
      writeCanvasScene(vaultPath, filePath, itemId, scene, existing.createdAt, now)

      tx.update(canvases)
        .set({
          title: nextTitle,
          filePath,
          // Always read back off the path, never echoed from the payload: the
          // file's location IS the canvas's folder. A move the filesystem
          // refused keeps the old path, and the stored folder has to describe
          // where the document actually is or every later lookup by folder
          // misses it. Reading it back canonicalizes too (`CON` → `CON canvas`).
          folder: folderOfCanvasPath(filePath),
          icon: data.icon !== undefined ? data.icon : existing.icon,
          snapshotCiphertext: '',
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
      // M5: ingest the incoming scene's asset sidecar under this canvas. Rows are
      // append-only (idempotent upsert); GC on save/delete prunes stale ones.
      recordSceneAssets(tx, existing.vaultId, itemId, descriptors)

      ctx.emit(CanvasChannels.events.UPDATED, {
        canvas: { id: itemId, title: nextTitle, createdAt: existing.createdAt, updatedAt: now }
      })
      return madeCopy ? 'conflict' : 'applied'
    })

    // AFTER commit (never inside the tx): fetch any missing asset files so the
    // applied scene renders. Skipped applies (D5 / LWW-lose) applied no scene, so
    // there is nothing to restore. Fire-and-forget: a download must not fail apply.
    if (result !== 'skipped' && descriptors.length > 0) {
      void restoreCanvasAssets(itemId, descriptors)
    }
    return result
  }

  applyDelete(ctx: ApplyContext, itemId: string, clock?: VectorClock): 'applied' | 'skipped' {
    let deletedFilePath: string | null = null
    const result = ctx.db.transaction((tx): 'applied' | 'skipped' => {
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
      deletedFilePath = existing.filePath
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

    // AFTER commit: GC the deleted canvas's assets (empty scene → all its hashes
    // are removal candidates; the GC union protects any still shared). Only when
    // a tombstone was actually written — a skipped delete leaves the canvas live.
    if (result === 'applied') {
      // Remove the document too: a tombstoned canvas must not keep haunting the
      // user's folder. Outside the tx — an fs failure must never roll back (and
      // thereby resurrect) the tombstone.
      const vaultPath = getCanvasVaultPath()
      if (vaultPath && deletedFilePath) {
        deleteCanvasFileSync(resolveCanvasFile(vaultPath, deletedFilePath))
      }
      void gcDeletedCanvasAssets(itemId)
    }
    return result
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
    _vaultKey?: Uint8Array
  ): string | null {
    const vaultPath = getCanvasVaultPath()
    if (!vaultPath) return null
    const row = db.select().from(canvases).where(eq(canvases.id, itemId)).get()
    if (!row) return null
    const scene = readCanvasScene(vaultPath, row.filePath)
    // No readable document (unmigrated legacy row, or a file the user moved
    // away): push nothing rather than a scene-less payload, which the receiving
    // device would skip anyway (D5) after burning a round trip.
    if (scene === null) {
      log.warn('Skipping canvas push without a readable document', { itemId })
      // Sizes the never-syncing unreadable/moved-file canvas population.
      trackMainLog('warn', {
        scope: 'CanvasHandler',
        action: 'push_skipped_unreadable',
        errorCode: 'canvas_unreadable'
      })
      return null
    }
    return JSON.stringify({
      id: row.id,
      vaultId: row.vaultId,
      title: row.title,
      scene,
      folder: row.folder ?? null,
      icon: row.icon ?? null,
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
    vaultPath: string,
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

    // The LOSING ink gets its own document on disk, so the user finds it in the
    // vault next to the winner instead of only inside the app — and "next to"
    // means the winner's FOLDER, taken off the path the document actually sits
    // at. Left at the root, the copy is filed away from the canvas it forked
    // from, and it pushes `folder: null`, so every other device buries it at
    // ITS root too. A legacy row with no file has no folder to inherit.
    const copyFolder = existing.filePath ? folderOfCanvasPath(existing.filePath) : null
    const copyPath = allocateCanvasPath(vaultPath, copyTitle, new Set(), null, copyFolder)
    writeCanvasScene(vaultPath, copyPath, copyId, localScene, now, now)

    tx.insert(canvases)
      .values({
        id: copyId,
        vaultId: existing.vaultId,
        title: copyTitle,
        filePath: copyPath,
        // Read back off the allocated path, the same invariant every other
        // placement write in this module holds to.
        folder: folderOfCanvasPath(copyPath),
        snapshotCiphertext: '',
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

    // M5 (R12 data-loss guard): the copy holds the LOSING LOCAL scene verbatim,
    // so it must own asset rows for the assets THAT scene references — read from
    // `localScene`, NOT the incoming winning scene. This puts the copy's hashes
    // into the GC union (`hashesReferencedByOtherCanvases`), so when the original
    // is later overwritten/deleted, GC will not reap an asset the copy still uses.
    recordSceneAssets(tx, existing.vaultId, copyId, readMemryAssets(localScene))

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
