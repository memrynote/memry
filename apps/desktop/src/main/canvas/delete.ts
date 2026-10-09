/**
 * The one canvas delete: asset GC, tombstone, sync, renderer event. The app's
 * delete and a document removed outside the app (the vault watcher's unlink,
 * the same path a note's removal takes) both end here, so every device hears
 * about either (#2938).
 *
 * @module canvas/delete
 */

import { isNull } from 'drizzle-orm'
import { CanvasChannels, type CanvasDeletedEvent } from '@memry/contracts/canvas-api'
import { canvases } from '@memry/db-schema/data-schema'
import type { DataDb } from '../database'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import { reconcileCanvasAssets } from './assets/asset-service'
import { buildAssetServiceContext } from './assets/asset-service-context'
import {
  canvasPathKey,
  listCanvasFiles,
  readCanvasFileSync,
  readCanvasMeta,
  resolveCanvasFile
} from './scene-file'
import { deleteCanvas } from './store'
import { syncCanvasDelete } from './sync-bridge'
import { getCanvasContext } from './vault-key'

export async function removeCanvas(
  id: string,
  trash: (absolutePath: string) => Promise<void>
): Promise<boolean> {
  const { db, vaultPath } = getCanvasContext()

  // GC this canvas's assets before the row is tombstoned (the other-canvas
  // union keeps assets shared with surviving canvases). Reads the
  // canvas_assets rows, so it must run before soft-delete/sync-delete.
  const assetCtx = buildAssetServiceContext()
  if (assetCtx) {
    await reconcileCanvasAssets(assetCtx, id, '')
  }

  const success = await deleteCanvas(db, vaultPath, id, trash)
  if (success) {
    syncCanvasDelete(id)
    const event: CanvasDeletedEvent = { id }
    broadcastToAllWindows(CanvasChannels.events.DELETED, event)
  }
  return success
}

/**
 * The live canvas whose document is at this vault-relative path. Matched case-
 * and Unicode-insensitively, like reconcile: macOS reports NFD names for the
 * NFC path we stored. The app's own delete tombstones the row before the file
 * goes, so its unlink finds nothing here.
 */
export function findLiveCanvasIdAtPath(db: DataDb, relativePath: string): string | null {
  const key = canvasPathKey(relativePath)
  const row = db
    .select({ id: canvases.id, filePath: canvases.filePath })
    .from(canvases)
    .where(isNull(canvases.deletedAt))
    .all()
    .find((candidate) => candidate.filePath && canvasPathKey(candidate.filePath) === key)
  return row?.id ?? null
}

/**
 * Whether a document carrying this canvas id is still in `canvases/`. A canvas
 * moved or renamed in Finder unlinks its old path but stays the same canvas;
 * the next vault-open reconcile re-points the row to where it went.
 */
export function canvasDocumentExists(vaultPath: string, id: string): boolean {
  return listCanvasFiles(vaultPath).some((filePath) => {
    const content = readCanvasFileSync(resolveCanvasFile(vaultPath, filePath))
    return content !== null && readCanvasMeta(content)?.id === id
  })
}
