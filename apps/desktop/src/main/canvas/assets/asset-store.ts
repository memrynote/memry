/**
 * Canvas asset store — drizzle CRUD for canvas_assets: the per-device dedup
 * index + GC bookkeeping for externalized canvas image assets (M5).
 *
 * Electron-free (mirrors main/canvas/store.ts): functions take `db` as a
 * parameter so they stay testable without the keychain or electron runtime.
 */

import { and, eq, gt, inArray, isNull, ne, or } from 'drizzle-orm'
import {
  canvasAssets,
  canvases,
  deletedAssetReleases,
  type CanvasAssetRow,
  type NewCanvasAssetRow
} from '@memry/db-schema'
import type { DataDb } from '../../database'

/**
 * Vault-scoped dedup lookup: a row whose server chunks are still held, so a
 * new canvas can point at them without uploading.
 *
 * A dedup hit adds no server ref, so the source row must belong to a canvas
 * whose chunks no release can have freed (#3015):
 * - a live canvas, or
 * - a canvas THIS device deleted whose release is still pending inside the
 *   grace period. The release runs here, after this upload's row exists, and
 *   keeps every hash a live canvas holds.
 * A row of any other deleted canvas is never a source. On a peer the delete
 * left no release record and `canvases.deletedAt` is the apply time, not the
 * deleter's, so the deleting device may already have freed those chunks.
 * Rows of a canvas whose release ran are skipped too: only the kept ones
 * survive, and they stay only as restore links (see `releaseCanvas`).
 */
export function findAssetByContentHash(
  db: DataDb,
  vaultId: string,
  contentHash: string,
  now = Date.now()
): CanvasAssetRow | undefined {
  const row = db
    .select({ asset: canvasAssets })
    .from(canvasAssets)
    .innerJoin(canvases, eq(canvases.id, canvasAssets.canvasId))
    .leftJoin(
      deletedAssetReleases,
      and(
        eq(deletedAssetReleases.itemType, 'canvas'),
        eq(deletedAssetReleases.itemId, canvasAssets.canvasId)
      )
    )
    .where(
      and(
        eq(canvasAssets.vaultId, vaultId),
        eq(canvasAssets.contentHash, contentHash),
        or(
          isNull(canvases.deletedAt),
          gt(deletedAssetReleases.deletedAt, now - ASSET_RELEASE_GRACE_MS)
        )
      )
    )
    .limit(1)
    .get()
  return row?.asset
}

/** Record a (canvas, asset) reference row. Upsert on the (canvasId, contentHash) PK. */
export function recordAsset(db: DataDb, row: NewCanvasAssetRow): void {
  db.insert(canvasAssets).values(row).onConflictDoNothing().run()
}

/** All asset rows for one canvas (the "previous" set for a GC diff). */
export function listAssetsByCanvas(db: DataDb, canvasId: string): CanvasAssetRow[] {
  return db.select().from(canvasAssets).where(eq(canvasAssets.canvasId, canvasId)).all()
}

/**
 * How long a deleted note or canvas can be restored with its stored assets
 * (#3015, Kaan's call). After it, `deleted-asset-release` frees them.
 */
export const ASSET_RELEASE_GRACE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * The GC union: contentHashes referenced by any OTHER canvas in the vault
 * (excludes canvasId). A deleted canvas counts only during its grace period,
 * while it can still be restored; after it, its rows no longer keep an image
 * a live board drops (#3015).
 */
export function hashesReferencedByOtherCanvases(
  db: DataDb,
  vaultId: string,
  canvasId: string,
  now = Date.now()
): Set<string> {
  const rows = db
    .select({ contentHash: canvasAssets.contentHash })
    .from(canvasAssets)
    .innerJoin(canvases, eq(canvases.id, canvasAssets.canvasId))
    .where(
      and(
        eq(canvasAssets.vaultId, vaultId),
        ne(canvasAssets.canvasId, canvasId),
        or(isNull(canvases.deletedAt), gt(canvases.deletedAt, now - ASSET_RELEASE_GRACE_MS))
      )
    )
    .all()
  return new Set(rows.map((row) => row.contentHash))
}

/** Prune specific asset rows for one canvas (after a scene save/delete removes those images). */
export function deleteCanvasAssetRows(db: DataDb, canvasId: string, contentHashes: string[]): void {
  if (contentHashes.length === 0) return
  db.delete(canvasAssets)
    .where(
      and(eq(canvasAssets.canvasId, canvasId), inArray(canvasAssets.contentHash, contentHashes))
    )
    .run()
}
