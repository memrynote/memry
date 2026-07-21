/**
 * Canvas asset store — drizzle CRUD for canvas_assets: the per-device dedup
 * index + GC bookkeeping for externalized canvas image assets (M5).
 *
 * Electron-free (mirrors main/canvas/store.ts): functions take `db` as a
 * parameter so they stay testable without the keychain or electron runtime.
 */

import { and, eq, inArray, ne } from 'drizzle-orm'
import { canvasAssets, type CanvasAssetRow, type NewCanvasAssetRow } from '@memry/db-schema'
import type { DataDb } from '../../database'

/** Vault-scoped dedup lookup: has any canvas already externalized this contentHash? */
export function findAssetByContentHash(
  db: DataDb,
  vaultId: string,
  contentHash: string
): CanvasAssetRow | undefined {
  return db
    .select()
    .from(canvasAssets)
    .where(and(eq(canvasAssets.vaultId, vaultId), eq(canvasAssets.contentHash, contentHash)))
    .limit(1)
    .get()
}

/** Record a (canvas, asset) reference row. Upsert on the (canvasId, contentHash) PK. */
export function recordAsset(db: DataDb, row: NewCanvasAssetRow): void {
  db.insert(canvasAssets).values(row).onConflictDoNothing().run()
}

/** All asset rows for one canvas (the "previous" set for a GC diff). */
export function listAssetsByCanvas(db: DataDb, canvasId: string): CanvasAssetRow[] {
  return db.select().from(canvasAssets).where(eq(canvasAssets.canvasId, canvasId)).all()
}

/** The GC union: contentHashes referenced by any OTHER canvas in the vault (excludes canvasId). */
export function hashesReferencedByOtherCanvases(
  db: DataDb,
  vaultId: string,
  canvasId: string
): Set<string> {
  const rows = db
    .select({ contentHash: canvasAssets.contentHash })
    .from(canvasAssets)
    .where(and(eq(canvasAssets.vaultId, vaultId), ne(canvasAssets.canvasId, canvasId)))
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
