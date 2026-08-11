/**
 * Which directory the index means when a caller names a canvas folder.
 *
 * Shared by BOTH canvas stores deliberately. `canvas/store.ts` writes a folder
 * onto a canvas row and `canvas/folder-store.ts` writes one onto a folder row;
 * if the two resolved the same caller string differently, one directory would
 * end up with two spellings in the index and every folder-scoped query would
 * see half of it. Keeping the resolution in one function is what makes the
 * settled invariant — **a stored folder is the path the index already uses for
 * that directory** — hold across both tables.
 *
 * @module canvas/folder-lookup
 */

import { and, eq, isNull } from 'drizzle-orm'

import { canvasFolderSyncId } from '@memry/contracts/canvas-folder-types'
import { canvasFolders, type CanvasFolderRow } from '@memry/db-schema/data-schema'

import type { DataDb } from '../database'
import { portableCanvasFolder } from './scene-file'

/**
 * The transaction handle better-sqlite3's Drizzle driver hands a callback.
 * Accepted alongside `DataDb` so a store can resolve a folder from INSIDE the
 * transaction that is about to write it.
 */
export type FolderTx = Parameters<Parameters<DataDb['transaction']>[0]>[0]

export type FolderReader = DataDb | FolderTx

/** The live row for a canonical folder path, or null. */
export function liveFolderRow(db: FolderReader, canonicalFolder: string): CanvasFolderRow | null {
  return (
    db
      .select()
      .from(canvasFolders)
      .where(
        and(
          eq(canvasFolders.id, canvasFolderSyncId(canonicalFolder)),
          isNull(canvasFolders.deletedAt)
        )
      )
      .get() ?? null
  )
}

/**
 * The STORED path a caller's folder string refers to, or its canonical form
 * when no row holds it. Null for the root.
 *
 * The row wins on case and Unicode form, and it has to: `canvasFolderSyncId` is
 * NFC + lowercase, so `work` resolves the row stored as `Work` — but the
 * FILESYSTEM is not so forgiving. On Linux (a shipped platform) `canvases/work`
 * and `canvases/Work` are two different directories, so addressing the disk with
 * the caller's spelling would resolve one folder and then mkdir/rename another.
 * Building a CHILD path has the same problem: a rename of `work/q3` must keep
 * the parent spelled the way the rows spell it. And a canvas filed under `work`
 * while its folder row says `Work` is a canvas the folder tree lists nowhere.
 *
 * Strict, via `portableCanvasFolder` → `normalizeFolder`: this runs on a folder
 * a caller CHOSE, so one past `MAX_CANVAS_FOLDER_DEPTH` throws here rather than
 * being written and then never walked to again.
 */
export function storedFolderPath(db: FolderReader, folder: string | null): string | null {
  const canonical = portableCanvasFolder(folder)
  if (!canonical) return null
  return liveFolderRow(db, canonical)?.path ?? canonical
}
