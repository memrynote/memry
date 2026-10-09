/**
 * The one canvas delete: tombstone, sync, renderer event. The app's
 * delete and a document removed outside the app (the vault watcher's unlink,
 * the same path a note's removal takes) both end here, so every device hears
 * about either (#2938).
 *
 * @module canvas/delete
 */

import { isNull } from 'drizzle-orm'
import { CanvasChannels, type CanvasDeletedEvent } from '@memry/contracts/canvas-api'
import { canvases } from '@memry/db-schema/data-schema'
import { getDatabase, type DataDb } from '../database'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import { createLogger } from '../lib/logger'
import { trackMainError } from '../telemetry/diagnostics'
import { trackPendingDelete } from '../vault/rename-tracker'
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

const log = createLogger('CanvasDelete')

export async function removeCanvas(
  id: string,
  trash: (absolutePath: string) => Promise<void>
): Promise<boolean> {
  const { db, vaultPath } = getCanvasContext()

  // The canvas's asset files and server refs are kept, like a deleted note's
  // attachments (`deleteNoteCommand` only trashes the .md): a document put
  // back from the Trash re-imports its images on the next reconcile (#3002).

  const success = await deleteCanvas(db, vaultPath, id, trash)
  if (success) {
    syncCanvasDelete(id)
    const event: CanvasDeletedEvent = { id }
    broadcastToAllWindows(CanvasChannels.events.DELETED, event)
  }
  return success
}

/**
 * A canvas document unlinked outside the app becomes a canvas delete once the
 * rename window closes and the document is shown to be gone. The tombstone
 * syncs to every device, so every doubt keeps the canvas. Its assets stay on
 * disk and on the server. `isGone` is the watcher's check that the file is
 * really missing from a reachable vault, shared with a note's removal.
 */
export function trackExternalCanvasRemoval(
  vaultPath: string,
  relativePath: string,
  isGone: () => Promise<boolean>
): void {
  // The app's own delete tombstones the row before the file goes, so its
  // unlink finds nothing here.
  const id = findLiveCanvasIdAtPath(getDatabase(), relativePath)
  if (!id) return
  // No content hash: a canvas move never reaches `checkForRename`, so the
  // window only lets the move's `add` land before the checks below run.
  trackPendingDelete(id, '', relativePath, async () => {
    try {
      if (!(await isGone())) return
      const db = getDatabase()
      // The app or a sync apply moved it meanwhile and re-pointed the row.
      if (findLiveCanvasIdAtPath(db, relativePath) !== id) return
      if (mayStillHoldCanvas(db, vaultPath, id)) return
      // The document is already gone, so there is nothing to trash.
      await removeCanvas(id, async () => {})
    } catch (error) {
      log.error('Failed to delete a canvas removed outside the app; keeping it', {
        id,
        path: relativePath,
        error
      })
      trackMainError('canvas', 'external_delete', error)
    }
  })
}

/**
 * The live canvas whose document is at this vault-relative path. Matched case-
 * and Unicode-insensitively, like reconcile: macOS reports NFD names for the
 * NFC path we stored.
 */
function findLiveCanvasIdAtPath(db: DataDb, relativePath: string): string | null {
  const key = canvasPathKey(relativePath)
  return (
    liveCanvasPaths(db).find((row) => row.filePath && canvasPathKey(row.filePath) === key)?.id ??
    null
  )
}

export function liveCanvasPaths(db: DataDb): Array<{ id: string; filePath: string | null }> {
  return db
    .select({ id: canvases.id, filePath: canvases.filePath })
    .from(canvases)
    .where(isNull(canvases.deletedAt))
    .all()
}

/**
 * Whether a document in `canvases/` may still be this canvas: moved or renamed
 * in Finder, it unlinks its old path but stays the same canvas, and the next
 * vault-open reconcile re-points the row to it. Only files no live row owns
 * are read, since a moved document sits at a path nobody owns yet; that is
 * usually zero or one read. A file that cannot be read or parsed counts as
 * this canvas: only a positive absence of the id deletes it. The canvas's own
 * row owns nothing here: a case-only rename on a case-sensitive volume leaves
 * the document at a path that still matches the row's old one.
 */
function mayStillHoldCanvas(db: DataDb, vaultPath: string, id: string): boolean {
  const owned = new Set(
    liveCanvasPaths(db)
      .filter((row) => row.id !== id)
      .map((row) => row.filePath)
      .filter((filePath): filePath is string => Boolean(filePath))
      .map(canvasPathKey)
  )
  return listCanvasFiles(vaultPath)
    .filter((filePath) => !owned.has(canvasPathKey(filePath)))
    .some((filePath) => {
      let content: string | null
      try {
        content = readCanvasFileSync(resolveCanvasFile(vaultPath, filePath))
      } catch (error) {
        log.warn('Canvas file cannot be read; keeping the removed canvas', { id, filePath, error })
        return true
      }
      // Gone between the listing and the read.
      if (content === null) return false
      try {
        JSON.parse(content)
      } catch {
        log.warn('Canvas file cannot be parsed; keeping the removed canvas', { id, filePath })
        return true
      }
      return readCanvasMeta(content)?.id === id
    })
}
