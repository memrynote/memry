/**
 * Canvas folder store — real directories under `<vault>/canvases`, indexed by
 * the `canvas_folders` table.
 *
 * The DIRECTORY is the truth for placement, exactly as the `.excalidraw` file is
 * the truth for ink. A canvas's own folder lives on its `canvases` row; this
 * table exists for the two things the directory alone cannot carry across
 * devices: a folder's icon, and the existence of an EMPTY folder.
 *
 * Two rules run through everything below.
 *
 * **Directory first, row second.** Every mutation touches the filesystem before
 * the database, so a crash in between leaves a folder the next reconcile can
 * adopt rather than a row pointing at nothing.
 *
 * **The stored path is the ON-DISK-CANONICAL one** (`portableCanvasFolder`),
 * never the string the caller asked for. A folder requested as `CON` lives on
 * disk as `CON canvas`, and a row holding `CON` would point the index at a
 * directory that does not exist.
 *
 * @module canvas/folder-store
 */

import { existsSync, mkdirSync, renameSync, rmdirSync } from 'fs'
import path from 'path'
import { and, eq, isNull } from 'drizzle-orm'

import type { CanvasFolder } from '@memry/contracts/canvas-folder-api'
import { canvasFolderSyncId } from '@memry/contracts/canvas-folder-types'
import {
  canvasFolders,
  canvases,
  canvasEntityRefs,
  type CanvasFolderRow
} from '@memry/db-schema/data-schema'

import type { DataDb } from '../database'
import { createLogger } from '../lib/logger'
import {
  enqueueLocalSyncCreate,
  enqueueLocalSyncDelete,
  enqueueLocalSyncUpdate
} from '../sync/local-mutations'
import { CanvasFolderError, CanvasFolderErrorCode } from './folder-errors'
// Re-exported so every existing importer (and the sync handler) keeps reaching
// these through the store; the class itself moved to a leaf module so
// `folder-paths` can raise the same typed failures without importing its own
// importer.
export { CanvasFolderError, CanvasFolderErrorCode }
import { liveFolderRow, storedFolderPath, type FolderTx } from './folder-lookup'
import {
  canvasPathKey,
  folderSegments,
  isDescendantFolder,
  joinFolder,
  parentFolder,
  rewriteFolderPrefix
} from './folder-paths'
import {
  CANVAS_DIR,
  ensureCanvasFolderDir,
  portableCanvasFolder,
  resolveCanvasFile
} from './scene-file'

const log = createLogger('CanvasFolderStore')

/**
 * Snapshot a folder row for a DELETE push.
 *
 * A delete carries the row's own state because the local row is a tombstone by
 * the time the queue drains — the sync controller bumps the `clock` in here and
 * sends it, so peers can tell this delete from an older one. Taken BEFORE the
 * tombstone is written, for the same reason.
 */
function deleteSnapshot(row: CanvasFolderRow): string {
  return JSON.stringify({
    id: row.id,
    vaultId: row.vaultId,
    path: row.path,
    icon: row.icon ?? null,
    clock: row.clock ?? {},
    deletedAt: row.deletedAt ?? null
  })
}

function toFolder(row: CanvasFolderRow): CanvasFolder {
  return {
    id: row.id,
    path: row.path,
    icon: row.icon ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

/**
 * Absolute path of a folder's directory.
 *
 * Routed through `resolveCanvasFile` so a folder that arrived from another
 * device's database (or a hand-edited row) cannot walk out of the vault.
 */
function folderDirPath(vaultPath: string, canonicalFolder: string): string {
  return resolveCanvasFile(vaultPath, `${CANVAS_DIR}/${canonicalFolder}`)
}

/**
 * Live folder rows at or under `canonicalFolder`, compared segment-wise.
 *
 * Filtered in JS rather than with a SQL `LIKE 'Work%'`: `Workshop` shares a
 * prefix with `Work` and is not one of its children, and a prefix match would
 * quietly re-root or delete it.
 */
function descendantFolderRows(
  db: DataDb | FolderTx,
  vaultId: string,
  canonicalFolder: string
): CanvasFolderRow[] {
  return db
    .select()
    .from(canvasFolders)
    .where(and(eq(canvasFolders.vaultId, vaultId), isNull(canvasFolders.deletedAt)))
    .all()
    .filter((row) => isDescendantFolder(row.path, canonicalFolder))
}

/** Live canvases sitting at or under `canonicalFolder`. Same prefix rule. */
function canvasesInFolder(
  db: DataDb | FolderTx,
  vaultId: string,
  canonicalFolder: string
): { id: string; folder: string | null; filePath: string | null }[] {
  return db
    .select({ id: canvases.id, folder: canvases.folder, filePath: canvases.filePath })
    .from(canvases)
    .where(and(eq(canvases.vaultId, vaultId), isNull(canvases.deletedAt)))
    .all()
    .filter((row) => isDescendantFolder(row.folder, canonicalFolder))
}

/**
 * Writes the row for a folder, reviving it if a tombstone already holds the id.
 *
 * `canvasFolderSyncId` is derived from the path, so the id a caller computes for
 * `Work` is the id a deleted `Work` still occupies — an INSERT would fail on the
 * primary key. Reviving is also what two offline devices need: both mint the
 * same id, so the second one merges instead of colliding.
 */
function upsertFolderRow(
  tx: FolderTx,
  values: {
    vaultId: string
    path: string
    icon: string | null
    createdAt: number
    updatedAt: number
  }
): CanvasFolderRow {
  const id = canvasFolderSyncId(values.path)
  tx.insert(canvasFolders)
    .values({
      id,
      vaultId: values.vaultId,
      path: values.path,
      icon: values.icon,
      createdAt: values.createdAt,
      updatedAt: values.updatedAt,
      deletedAt: null
    })
    .onConflictDoUpdate({
      target: canvasFolders.id,
      set: {
        vaultId: values.vaultId,
        path: values.path,
        icon: values.icon,
        updatedAt: values.updatedAt,
        deletedAt: null
      }
    })
    .run()
  return tx.select().from(canvasFolders).where(eq(canvasFolders.id, id)).get()!
}

/**
 * Writes a row for `path` only when NOTHING holds its derived id yet, and hands
 * back what it wrote (null when it wrote nothing).
 *
 * Deliberately not `liveFolderRow`: a TOMBSTONE occupies the id too, and this
 * function must never revive one. That is the whole difference from
 * `upsertFolderRow` — the rows it writes are implied (an ancestor on the way to
 * a folder the user asked for, a level the user's delete has to account for),
 * and an implied write must not undo an explicit delete, here or on a peer that
 * is mid-pull.
 *
 * `onConflictDoNothing` on top of the lookup is belt and braces: better-sqlite3
 * is synchronous and this runs inside a transaction, so no sync apply can land
 * between the two statements — but two devices deriving the same id from the
 * same path is the normal case, and converging beats colliding.
 */
function insertFolderRowIfAbsent(
  tx: FolderTx,
  values: {
    vaultId: string
    path: string
    createdAt: number
    updatedAt: number
    deletedAt: number | null
  }
): CanvasFolderRow | null {
  const id = canvasFolderSyncId(values.path)
  if (tx.select().from(canvasFolders).where(eq(canvasFolders.id, id)).get()) return null
  tx.insert(canvasFolders)
    .values({
      id,
      vaultId: values.vaultId,
      path: values.path,
      icon: null,
      createdAt: values.createdAt,
      updatedAt: values.updatedAt,
      deletedAt: values.deletedAt
    })
    .onConflictDoNothing()
    .run()
  return tx.select().from(canvasFolders).where(eq(canvasFolders.id, id)).get() ?? null
}

/**
 * Gives every ancestor of `canonicalFolder` a row, and returns the ones that
 * were actually written.
 *
 * A folder the tree shows but this table does not hold is MATERIALIZED — the
 * tree invents it from a canvas's own `folder` string, because a canvas can
 * arrive from sync long before its folder item does. Minting only the leaf left
 * those ancestors rowless, and a rowless folder is exactly the folder this table
 * exists for: it can carry no icon, and it does not reach another device when it
 * is empty.
 *
 * Lives here rather than in the renderer on purpose. Every caller — the tree,
 * the sidebar drop, the MCP tools, a future one — reaches folders through this
 * store, so the chain is minted once, where the transaction and the sync queue
 * already are, and the renderer cannot drift out of step with it.
 */
function mintAncestorFolderRows(
  tx: FolderTx,
  vaultId: string,
  canonicalFolder: string,
  now: number
): CanvasFolderRow[] {
  const segments = folderSegments(canonicalFolder)
  const minted: CanvasFolderRow[] = []
  for (let depth = 1; depth < segments.length; depth += 1) {
    const row = insertFolderRowIfAbsent(tx, {
      vaultId,
      path: segments.slice(0, depth).join('/'),
      createdAt: now,
      updatedAt: now,
      deletedAt: null
    })
    if (row) minted.push(row)
  }
  return minted
}

/**
 * Every folder path at or under `canonicalFolder` that these stored folder
 * strings imply — `canonicalFolder` itself always included.
 *
 * This is what a delete has to account for. `descendantFolderRows` finds the
 * folders that HAVE rows; the tree also shows the ones only a canvas's folder
 * string (or a deeper row's path) names, and each of those needs a tombstone of
 * its own or the peer holding its row syncs it straight back, empty.
 *
 * Spelling is re-rooted on the canonical form and deduped through
 * `canvasPathKey`, so a canvas filed under `work/q3` beneath a row spelled
 * `Work` does not mint a second folder for the same directory.
 *
 * `storedFolders` must already be at or under `canonicalFolder` — both callers
 * read them through `canvasesInFolder` / `descendantFolderRows`, which is where
 * the segment-wise "`Workshop` is not a child of `Work`" rule is applied.
 */
function impliedFolderPaths(canonicalFolder: string, storedFolders: (string | null)[]): string[] {
  const rootSegments = folderSegments(canonicalFolder)
  const byKey = new Map<string, string>()
  const collect = (segments: string[]): void => {
    for (let depth = rootSegments.length; depth <= segments.length; depth += 1) {
      const folderPath = segments.slice(0, depth).join('/')
      const key = canvasPathKey(folderPath)
      if (!byKey.has(key)) byKey.set(key, folderPath)
    }
  }

  collect(rootSegments)
  for (const folder of storedFolders) {
    collect([...rootSegments, ...folderSegments(folder).slice(rootSegments.length)])
  }
  return [...byKey.values()]
}

export function listCanvasFolders(db: DataDb, vaultId: string): CanvasFolder[] {
  return db
    .select()
    .from(canvasFolders)
    .where(and(eq(canvasFolders.vaultId, vaultId), isNull(canvasFolders.deletedAt)))
    .orderBy(canvasFolders.path)
    .all()
    .map(toFolder)
}

/**
 * Creates a folder: the directory first, then the row — and a row for every
 * ancestor that does not have one, because `ensureCanvasFolderDir` makes the
 * whole directory chain and the index has to describe the same tree.
 *
 * Idempotent — asking for a folder that already exists returns it rather than
 * failing, which is what a sync apply and a double-click both want. The ancestor
 * pass runs either way, so calling this on an existing leaf repairs a chain that
 * arrived incomplete.
 */
export function createCanvasFolder(
  db: DataDb,
  vaultPath: string,
  vaultId: string,
  parent: string | null,
  name: string
): CanvasFolder {
  // Throws on an empty name and past MAX_CANVAS_FOLDER_DEPTH, before anything
  // has been written. The parent is taken from its row, so a caller spelling it
  // `work` does not file the child under a second, differently-cased directory.
  const requested = joinFolder(storedFolderPath(db, parent ?? null), name)
  // The canonical form is what lands on disk, so it is what gets stored.
  const canonical = portableCanvasFolder(requested)
  if (!canonical)
    throw new CanvasFolderError(
      'Canvas folder name cannot be empty',
      CanvasFolderErrorCode.INVALID_NAME
    )

  // Resolved BEFORE the directory is created, for the same reason: the row's id
  // is case-insensitive, so `work` finds the row stored as `Work`, and mkdir-ing
  // the caller's spelling first would leave a second directory on a
  // case-sensitive filesystem with no row pointing at it.
  const existing = liveFolderRow(db, canonical)
  const stored = existing?.path ?? canonical

  // Directory first, row second. `mkdir -p`, so this is also what puts every
  // ancestor directory on disk — the rows below just catch the index up.
  ensureCanvasFolderDir(vaultPath, stored)

  const now = Date.now()
  const { row, ancestors } = db.transaction((tx) => {
    const ancestors = mintAncestorFolderRows(tx, vaultId, stored, now)
    if (existing) return { row: existing, ancestors }
    return {
      row: upsertFolderRow(tx, {
        vaultId,
        path: canonical,
        icon: null,
        createdAt: now,
        updatedAt: now
      }),
      ancestors
    }
  })
  // After the rows exist, never inside the transaction: the queue write is its
  // own transaction, and a folder that is not committed yet has nothing to push.
  for (const ancestor of ancestors) enqueueLocalSyncCreate('canvas_folder', ancestor.id)
  // An already-live leaf is not a new folder; re-announcing it would push a
  // create for a row the peers already have.
  if (!existing) enqueueLocalSyncCreate('canvas_folder', row.id)
  return toFolder(row)
}

/**
 * Moves a folder from one path to another — the one code path behind both
 * rename and move, because they differ only in which part of the path changes.
 *
 * The source is the ROW, not a string, so the directory this touches is always
 * the one the index points at (see `storedFolderPath`).
 *
 * Refuses three things, all before the filesystem is touched:
 * - landing inside its own subtree, which `renameSync` would happily do, leaving
 *   every canvas below unreachable from the tree meant to contain it;
 * - landing on a destination that already exists, which would either absorb an
 *   empty directory (losing its row and its icon) or fail with a raw ENOTEMPTY;
 * - any rewrite that breaches the depth cap, which used to throw with the
 *   directory already moved and the index rolled back.
 *
 * If the index write fails anyway, the directory goes back. Disk and index must
 * never disagree about where a canvas lives.
 */
function relocateFolder(
  db: DataDb,
  vaultPath: string,
  vaultId: string,
  row: CanvasFolderRow,
  to: string
): CanvasFolder | null {
  const toPath = portableCanvasFolder(to)
  if (!toPath) return null

  const from = row.path
  if (from === toPath) return toFolder(row)

  // A folder counts as a descendant of itself, so a case-only rename has to be
  // answered before the guards — otherwise renaming `Work` to `work` would read
  // as a cycle, and its own directory would read as an occupied destination.
  const sameFolder = canvasPathKey(from) === canvasPathKey(toPath)
  if (!sameFolder) {
    if (isDescendantFolder(toPath, from)) {
      // No folder name in the message: it is user content and this reaches the
      // UI and telemetry.
      throw new CanvasFolderError(
        'A canvas folder cannot be moved into its own descendant',
        CanvasFolderErrorCode.DESCENDANT
      )
    }
    if (liveFolderRow(db, toPath) || existsSync(folderDirPath(vaultPath, toPath))) {
      throw new CanvasFolderError(
        'A canvas folder with that name already exists',
        CanvasFolderErrorCode.EXISTS
      )
    }
  }

  // Everything that can throw is computed BEFORE the filesystem is touched.
  // `rewriteFolderPrefix` enforces the depth cap, so a nested child pushed past
  // it fails here, with nothing moved — rather than mid-transaction, which left
  // the directory moved on disk and the index rolled back, and every canvas in
  // the subtree unopenable. Reading now and writing inside the transaction is
  // safe: this whole function is synchronous, so nothing can write to the
  // database in between.
  const canvasMoves = canvasesInFolder(db, vaultId, from).map((canvas) => ({
    canvas,
    nextFolder: rewriteFolderPrefix(canvas.folder, from, toPath)
  }))
  const folderMoves = descendantFolderRows(db, vaultId, from).map((folder) => ({
    folder,
    nextPath: rewriteFolderPrefix(folder.path, from, toPath)
  }))

  // Directory first: a crash after this leaves a real folder the next reconcile
  // adopts, instead of rows pointing at a directory that is not there.
  const undoMove = moveFolderDir(vaultPath, from, toPath)

  const now = Date.now()
  // Everything the sync queue needs, collected inside the transaction and
  // enqueued after it commits: a rolled-back move must not leave pushes behind.
  let moved: {
    target: CanvasFolderRow | null
    written: CanvasFolderRow[]
    ancestors: CanvasFolderRow[]
  }
  try {
    moved = db.transaction((tx) => {
      for (const { canvas, nextFolder } of canvasMoves) {
        const changes: Partial<typeof canvases.$inferInsert> = {
          folder: nextFolder,
          updatedAt: now
        }
        // The file moved with its directory, so the stored path has to follow it
        // or the ink becomes unreadable. Only the folder part changes; the
        // filename is the canvas's own and is left exactly as it is.
        if (canvas.filePath) {
          const filename = canvas.filePath.split('/').pop()!
          changes.filePath = nextFolder
            ? `${CANVAS_DIR}/${nextFolder}/${filename}`
            : `${CANVAS_DIR}/${filename}`
        }
        tx.update(canvases).set(changes).where(eq(canvases.id, canvas.id)).run()
      }

      // Tombstone every old row BEFORE writing the replacements: a case-only
      // rename keeps the same derived id, so the two sets overlap and the revive
      // has to come last for the row to end up live.
      for (const { folder } of folderMoves) {
        tx.update(canvasFolders)
          .set({ deletedAt: now, updatedAt: now })
          .where(eq(canvasFolders.id, folder.id))
          .run()
      }
      // A drop onto a materialized folder lands the subtree under a parent with
      // no row of its own; the destination chain gets the same treatment a
      // create gives it.
      const ancestors = mintAncestorFolderRows(tx, vaultId, toPath, now)
      let target: CanvasFolderRow | null = null
      const written: CanvasFolderRow[] = []
      for (const { folder, nextPath } of folderMoves) {
        // Unreachable: `toPath` is a real folder, so no rewrite lands at the root.
        if (!nextPath) continue
        const replacement = upsertFolderRow(tx, {
          vaultId,
          path: nextPath,
          // The icon is the only thing this table carries that the directory
          // cannot; losing it on a rename would look like the folder was
          // recreated.
          icon: folder.icon ?? null,
          createdAt: folder.createdAt,
          updatedAt: now
        })
        written.push(replacement)
        if (folder.id === row.id) target = replacement
      }
      return { target, written, ancestors }
    })
  } catch (err) {
    // The rows still say the folder is where it was, so the directory has to be
    // there too. Best effort, and it must never mask the failure that got us
    // here.
    try {
      undoMove()
    } catch (undoErr) {
      log.error('Could not move the canvas folder back after a failed index write', {
        code: (undoErr as NodeJS.ErrnoException).code
      })
    }
    throw err
  }

  // A case-only rename keeps the same derived id, so the row it "tombstoned" is
  // the row it just revived. Pushing a delete for it would tell every peer the
  // folder is gone.
  const revivedIds = new Set(moved.written.map((folder) => folder.id))
  for (const { folder } of folderMoves) {
    if (revivedIds.has(folder.id)) continue
    enqueueLocalSyncDelete('canvas_folder', folder.id, deleteSnapshot(folder))
  }
  for (const folder of moved.ancestors) {
    enqueueLocalSyncCreate('canvas_folder', folder.id)
  }
  for (const folder of moved.written) {
    enqueueLocalSyncUpdate('canvas_folder', folder.id)
  }
  // The canvases moved with the directory: their stored path changed, so peers
  // need the new placement or the file lands in the old folder over there.
  for (const { canvas } of canvasMoves) {
    enqueueLocalSyncUpdate('canvas', canvas.id)
  }

  return moved.target ? toFolder(moved.target) : null
}

/**
 * Renames the directory on disk, or creates the destination when the row has no
 * directory of its own (a sibling device created the folder; the user removed it
 * in Finder).
 *
 * Returns the undo for what it did, so a failed index write can put the
 * directory back. Errors are re-thrown path-free: a half-moved tree is worse
 * than a refused move, and libuv's message would carry both absolute paths.
 */
function moveFolderDir(vaultPath: string, fromPath: string, toPath: string): () => void {
  const fromAbs = folderDirPath(vaultPath, fromPath)
  const toAbs = folderDirPath(vaultPath, toPath)
  if (!existsSync(fromAbs)) {
    log.warn('Canvas folder has no directory on disk; creating the destination instead')
    mkdirSync(toAbs, { recursive: true })
    // Only ever removes the empty directory this call just made — `rmdirSync`
    // refuses a non-empty one, which is exactly the guard we want here.
    return () => rmdirSync(toAbs)
  }
  try {
    mkdirSync(path.dirname(toAbs), { recursive: true })
    renameSync(fromAbs, toAbs)
  } catch (err) {
    throw new CanvasFolderError(
      'Could not move the canvas folder',
      CanvasFolderErrorCode.MOVE_FAILED,
      { cause: err }
    )
  }
  return () => {
    mkdirSync(path.dirname(fromAbs), { recursive: true })
    renameSync(toAbs, fromAbs)
  }
}

/** Renames a folder in place, keeping its parent. */
export function renameCanvasFolder(
  db: DataDb,
  vaultPath: string,
  vaultId: string,
  folderPath: string,
  name: string
): CanvasFolder | null {
  const canonical = portableCanvasFolder(folderPath)
  if (!canonical) return null
  const row = liveFolderRow(db, canonical)
  if (!row) return null
  // The parent comes off the ROW: renaming `work/q3` when the rows spell it
  // `Work/Q3` must not silently re-case the parent along the way.
  return relocateFolder(db, vaultPath, vaultId, row, joinFolder(parentFolder(row.path), name))
}

/** Re-parents a folder, keeping its own name. `parent` null means the root. */
export function moveCanvasFolder(
  db: DataDb,
  vaultPath: string,
  vaultId: string,
  folderPath: string,
  parent: string | null
): CanvasFolder | null {
  const canonical = portableCanvasFolder(folderPath)
  if (!canonical) return null
  const row = liveFolderRow(db, canonical)
  if (!row) return null
  // Both halves of the destination come off rows, never off the caller's
  // spelling — the leaf from the folder being moved, the parent from its row.
  const leaf = folderSegments(row.path).at(-1)!
  return relocateFolder(db, vaultPath, vaultId, row, joinFolder(storedFolderPath(db, parent), leaf))
}

/** Sets (or clears, with null) a folder's icon. No disk work: icons are index-only. */
export function setCanvasFolderIcon(
  db: DataDb,
  vaultId: string,
  folderPath: string,
  icon: string | null
): CanvasFolder | null {
  const canonical = portableCanvasFolder(folderPath)
  if (!canonical) return null

  const row = liveFolderRow(db, canonical)
  if (!row || row.vaultId !== vaultId) return null

  const now = Date.now()
  db.update(canvasFolders).set({ icon, updatedAt: now }).where(eq(canvasFolders.id, row.id)).run()
  // The icon is the only thing this table carries that the directory cannot, so
  // it is the one folder edit that reaches other devices through sync alone.
  enqueueLocalSyncUpdate('canvas_folder', row.id)
  return toFolder({ ...row, icon, updatedAt: now })
}

/**
 * Tombstones a folder, everything under it, and every canvas inside — then
 * sends the directory to the OS trash.
 *
 * The trash call is deliberately outside the transaction and after it: the
 * tombstone is the sync truth, and an fs failure that rolled it back would
 * resurrect a folder the user deleted on every device.
 *
 * `trash` is injected (rather than importing electron's `shell`) so the store
 * stays testable without an electron runtime, matching `canvas/store.ts`.
 *
 * @returns the ids of the canvases tombstoned along with the folder.
 */
export async function deleteCanvasFolder(
  db: DataDb,
  vaultPath: string,
  vaultId: string,
  folderPath: string,
  trash: (absolutePath: string) => Promise<void>
): Promise<string[]> {
  // The row's spelling, not the caller's: the directory that gets trashed has to
  // be the one the index points at.
  const canonical = storedFolderPath(db, folderPath)
  if (!canonical) return []

  const { deletedCanvasIds, deletedFolders } = db.transaction((tx) => {
    const now = Date.now()
    // Collected first: once the rows carry a deletedAt they no longer match the
    // "live canvases in this folder" query that found them. The folder strings
    // come along because they are what names the materialized levels below.
    const inside = canvasesInFolder(tx, vaultId, canonical)
    const ids = inside.map((row) => row.id)
    for (const id of ids) {
      tx.update(canvases).set({ deletedAt: now, updatedAt: now }).where(eq(canvases.id, id)).run()
      // The FK cascade only fires on hard deletes; prune advisory refs here so
      // ref-consuming queries never see tombstoned canvases.
      tx.delete(canvasEntityRefs).where(eq(canvasEntityRefs.canvasId, id)).run()
    }
    // Snapshotted pre-tombstone: the delete push carries the row as it was, and
    // its clock is what tells peers this delete is newer than what they hold.
    const folders = descendantFolderRows(tx, vaultId, canonical)
    for (const folder of folders) {
      tx.update(canvasFolders)
        .set({ deletedAt: now, updatedAt: now })
        .where(eq(canvasFolders.id, folder.id))
        .run()
    }

    // The levels the tree shows but this table never held — the deleted folder
    // itself when it had no row, and every rowless step between it and a canvas
    // (or a deeper row) below. Each gets a tombstone of its own: without one
    // there is nothing to push, and the peer that does hold the row keeps it,
    // so the folder the user deleted comes back, empty. A path that already has
    // a row is skipped, tombstone included — an earlier delete stands.
    const materialized: CanvasFolderRow[] = []
    for (const folderPath of impliedFolderPaths(canonical, [
      ...inside.map((row) => row.folder),
      ...folders.map((folder) => folder.path)
    ])) {
      const row = insertFolderRowIfAbsent(tx, {
        vaultId,
        path: folderPath,
        createdAt: now,
        updatedAt: now,
        deletedAt: now
      })
      if (row) materialized.push(row)
    }

    return { deletedCanvasIds: ids, deletedFolders: [...folders, ...materialized] }
  })

  // After the tombstones commit, never inside the transaction.
  for (const folder of deletedFolders) {
    enqueueLocalSyncDelete('canvas_folder', folder.id, deleteSnapshot(folder))
  }
  for (const id of deletedCanvasIds) {
    enqueueLocalSyncDelete('canvas', id)
  }

  const absolutePath = folderDirPath(vaultPath, canonical)
  if (existsSync(absolutePath)) {
    try {
      await trash(absolutePath)
    } catch (err) {
      // Trash can be unavailable (network volumes, some Linux setups). Unlike a
      // single canvas file, a folder is NOT force-removed as a fallback: it can
      // hold anything the user put there, and an unrecoverable recursive delete
      // is a worse outcome than a directory left on disk.
      //
      // The delete still stands. Reconcile re-adopts a tombstoned folder only
      // when its directory holds a document a LIVE canvas row owns, and this
      // call has just tombstoned every canvas in it — so the folder stays gone
      // in the app, here and on every other device, and what is left behind is
      // a directory the user can remove themselves.
      log.warn('Could not trash canvas folder; leaving the directory in place', {
        code: (err as NodeJS.ErrnoException).code
      })
    }
  }

  return deletedCanvasIds
}
