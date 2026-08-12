/**
 * Vault-open reconciliation for file-backed canvases.
 *
 * Two jobs, both idempotent and both safe to run on every open:
 *
 * 1. **Migration off the encrypted column.** Rows written before canvases became
 *    files carry a vault-key-encrypted `snapshot_ciphertext`. We decrypt once,
 *    write the `.excalidraw` file, and blank the column. A row we cannot decrypt
 *    (the master key changed under it — a local-only user upgrading to sync, a
 *    copied vault) keeps its ciphertext and stays `unreadable` in the UI: the
 *    ink is not thrown away, and it comes back if the old key ever returns.
 * 2. **Adoption.** Files in `canvases/` with no index row become canvases, and
 *    directories in `canvases/` with no row at all become canvas folders. This is
 *    what makes "copy the folder to another machine" work, and it is the same
 *    contract notes already have: the file is the truth, the table is an index.
 *    A directory whose row is a TOMBSTONE is the one exception — see the revival
 *    rule in the adoption loop. The truth for a deleted folder is the delete.
 *
 * The path is the truth for PLACEMENT the same way the file is the truth for
 * ink, so an adopted or re-pointed row always takes its `folder` from the path
 * the document actually sits at. A canvas dragged into a subfolder in Finder
 * shows up there in the app on the next open.
 *
 * Deliberately additive, in BOTH directions: a row whose file is missing is
 * reported, never tombstoned, and a folder row whose directory is missing gets
 * the directory back rather than a tombstone (see `restoreMissingFolderDirs`).
 * A half-copied vault (or a Dropbox mid-sync) must not delete canvases, and a
 * real delete already goes through the app.
 *
 * The single exception is the EMPTY directory of a folder the user already
 * deleted (see `pruneTombstonedFolderDirs`) — litter the sync apply order leaves
 * in the user's own vault, which nothing else ever comes back for. It removes no
 * content: a directory holding anything at all is left exactly as it is.
 *
 * @module canvas/reconcile
 */

import { Dirent, existsSync, readdirSync, renameSync } from 'fs'
import path from 'path'
import { and, eq, isNull, ne } from 'drizzle-orm'
import {
  canvasEntityRefs,
  canvasFolders,
  canvases,
  canvasLibraryItems
} from '@memry/db-schema/data-schema'

import type { CanvasLibraryItem } from '@memry/contracts/canvas-api'
import { canvasFolderSyncId } from '@memry/contracts/canvas-folder-types'
import { getOrCreateVaultUuid } from '../agent/storage/vault-id'
import type { DataDb } from '../database'
import { createLogger } from '../lib/logger'
import { generateId } from '../lib/id'
import { trackMainError, trackMainLog } from '../telemetry/diagnostics'
import { enqueueLocalSyncUpdate } from '../sync/local-mutations'
import { extractEntityRefsFromScene } from './scene-refs'
import { decryptCanvasLibraryItemForVault, decryptCanvasSceneForVault } from './encryption'
import { folderSegments, isDescendantFolder, MAX_CANVAS_FOLDER_DEPTH } from './folder-paths'
import { readCanvasLibrary, writeCanvasLibrary } from './library-file'
import {
  allocateCanvasPath,
  canvasDirPath,
  canvasPathKey,
  ensureCanvasDir,
  ensureCanvasFolderDir,
  folderOfCanvasPath,
  listCanvasFiles,
  portableCanvasFolder,
  readCanvasFileSync,
  readCanvasMeta,
  removeCanvasFolderDirIfEmpty,
  resolveCanvasFile,
  stripCanvasMeta,
  withCanvasMeta,
  writeCanvasFileSync
} from './scene-file'
import { getLegacyCanvasVaultKey } from './vault-key'

const log = createLogger('CanvasReconcile')

export interface CanvasReconcileResult {
  migrated: number
  unreadable: number
  adopted: number
  foldersAdopted: number
  /** Folder rows whose directory was put back on disk. */
  foldersRestored: number
  /** Emptied directories of already-deleted folders that were swept up. */
  foldersPruned: number
  missingFiles: number
  libraryItemsMigrated: number
}

/**
 * Folder paths (relative to `canvases/`) for every directory on disk.
 *
 * Same two rules as `listCanvasFiles`, and for the same reasons: dot-directories
 * are skipped so a cloud client's `.tmp`/`.trash` staging area never becomes a
 * visible folder, and the walk stops at `MAX_CANVAS_FOLDER_DEPTH` because a
 * folder deeper than that cannot be represented (`normalizeFolder` throws) and
 * holds canvases the file walk never lists either. `withFileTypes` reports a
 * symlink with `isDirectory() === false`, so the walk never follows one.
 */
function listCanvasFolderDirs(vaultPath: string): string[] {
  const root = canvasDirPath(vaultPath)
  if (!existsSync(root)) return []

  const found: string[] = []
  const walk = (absDir: string, relSegments: string[]): void => {
    if (relSegments.length > MAX_CANVAS_FOLDER_DEPTH) return
    if (relSegments.length > 0) found.push(relSegments.join('/'))
    let entries: Dirent[]
    try {
      entries = readdirSync(absDir, { withFileTypes: true })
    } catch {
      return // an unreadable directory must not take the whole walk down
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) walk(path.join(absDir, entry.name), [...relSegments, entry.name])
    }
  }

  walk(root, [])
  return found.sort()
}

/**
 * Renames one directory to its on-disk-canonical name, returning the name it
 * ends up with.
 *
 * Uniquified against its siblings the same way `allocateCanvasPath` uniquifies a
 * filename, and for the same reason: `Work ` and `Work` can coexist on macOS and
 * Linux, and renaming one onto the other would merge two folders the user keeps
 * apart (POSIX `rename` happily replaces an empty destination directory). A
 * refused rename is left alone — a directory we cannot canonicalize is skipped
 * by the adoption pass rather than indexed under a path no lookup resolves.
 */
function canonicalizeDirName(parentAbs: string, name: string): string {
  const canonical = portableCanvasFolder(name)
  // Null for a name that sanitizes away entirely (whitespace only). Renaming it
  // would invent a folder the user never named; leave it and skip it.
  if (!canonical || canonical === name) return name

  let target = canonical
  let counter = 1
  while (existsSync(path.join(parentAbs, target))) {
    counter += 1
    target = `${canonical} ${counter}`
  }
  try {
    renameSync(path.join(parentAbs, name), path.join(parentAbs, target))
    return target
  } catch (err) {
    // Name-free: directory names are user content and this reaches telemetry.
    log.warn('Could not rename a canvas folder to its portable name', {
      code: (err as NodeJS.ErrnoException).code
    })
    return name
  }
}

/**
 * Makes every directory under `canvases/` carry its portable name, top-down.
 *
 * The settled invariant is that a STORED folder is the on-disk-canonical form
 * (`portableCanvasFolder`), because every folder lookup canonicalizes before it
 * hits the row — so a directory a user made in Finder as `CON` or `Work ` would
 * otherwise produce a row the app can never address again: the folder shows up,
 * and rename/move/delete/set-icon all miss it. The other way round (store the
 * canonical name, keep the raw one for fs access) would need a second column to
 * remember the raw name, since `folderDirPath` addresses the disk with the
 * stored path alone.
 *
 * So the disk is what moves. `CON` cannot exist as a directory on Windows and
 * `Work ` resolves to `Work` there, which means the rename is also what makes
 * the vault portable in the first place — the same rule `portableCanvasBase`
 * already applies to every canvas the app writes.
 *
 * Runs BEFORE the file walk so an adopted canvas takes its folder from the
 * canonical path, and shallowest-first so a child's path is still valid when the
 * walk reaches it. Idempotent: a canonical tree is renamed nothing.
 */
function canonicalizeCanvasFolderDirs(vaultPath: string): void {
  const root = canvasDirPath(vaultPath)
  if (!existsSync(root)) return

  const walk = (absDir: string, depth: number): void => {
    if (depth > MAX_CANVAS_FOLDER_DEPTH) return
    let entries: Dirent[]
    try {
      entries = readdirSync(absDir, { withFileTypes: true })
    } catch {
      return // an unreadable directory must not take the whole walk down
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (!entry.isDirectory()) continue
      const name = canonicalizeDirName(absDir, entry.name)
      walk(path.join(absDir, name), depth + 1)
    }
  }

  walk(root, 0)
}

/**
 * Puts back the directory of every live folder row that has none.
 *
 * **The rule: reconcile never tombstones a folder row. A live row with no
 * directory gets the directory, not a delete.**
 *
 * It has to be this way round, because the two states that produce "row without
 * directory" are indistinguishable from here and one of them is the NORMAL one:
 *
 * - A folder made on another device arrives as a ROW ONLY —
 *   `canvas-folder-handler.applyUpsert` writes the row and emits an event, and
 *   nothing on the receiving side creates the directory. Tombstoning it would
 *   push a delete straight back at the device that just made the folder, and an
 *   empty folder is precisely what this table exists to carry.
 * - A directory the user removed in Finder. Recreating it costs an empty folder
 *   the user can delete in the app; tombstoning it costs the placement of every
 *   canvas row still filed under it, on every device.
 *
 * Creating the directory settles both: the synced folder finally appears where
 * the user expects it, and the sidebar stops pointing at nothing. This is the
 * same answer the file half already gives ("a row whose file is missing is
 * reported, never tombstoned"), and deleting a folder for real still goes
 * through `deleteCanvasFolder`, which trashes the directory AND tombstones the
 * row — so a tombstone is never restored here.
 *
 * Two rows are skipped rather than guessed at: one stored past the depth cap
 * (`listCanvasFiles` never walks that far, so the directory would hold canvases
 * the app cannot open), and one whose stored path is not the on-disk-canonical
 * form (no later lookup resolves it, so the directory would be one nothing
 * points at).
 *
 * @returns how many directories were created.
 */
function restoreMissingFolderDirs(
  vaultPath: string,
  rows: { path: string; deletedAt: number | null }[]
): number {
  let restored = 0
  for (const row of rows) {
    if (row.deletedAt !== null) continue
    const segments = folderSegments(row.path)
    if (segments.length === 0 || segments.length > MAX_CANVAS_FOLDER_DEPTH) continue
    if (portableCanvasFolder(row.path) !== row.path) continue
    if (existsSync(path.join(canvasDirPath(vaultPath), ...segments))) continue
    try {
      ensureCanvasFolderDir(vaultPath, row.path)
      restored += 1
    } catch (err) {
      // Name-free: folder paths are user content and this reaches telemetry.
      log.warn('Could not restore the directory of a canvas folder', {
        code: (err as NodeJS.ErrnoException).code
      })
    }
  }
  return restored
}

/**
 * Sweeps up the emptied directory of a folder the user already deleted.
 *
 * **Why here.** `canvasFolderHandler.applyDelete` already removes the directory
 * when a remote delete lands, but only if it is empty by then — and it usually
 * is not: `canvas` and `canvas_folder` share a rank in `PULL_APPLY_ORDER`, so
 * the folder delete regularly applies while the documents inside it are still on
 * disk. The `rmdir` is a no-op, the canvas deletes empty the directory a moment
 * later, and nothing in the apply path ever comes back to it. The user deletes a
 * folder on one device and the other keeps an empty directory in the vault
 * folder they see in Finder, forever.
 *
 * Retrying at vault open rather than chasing the apply order: reconcile is
 * ordering-independent and already walks this tree, so it repairs the leftovers
 * of every past release too — including the ones already sitting in users'
 * vaults. Forcing a rank on the pull would fix only deletes that arrive from now
 * on, and only when both halves arrive in the same pull.
 *
 * **What it may take.** Only the OWN directory of a folder whose row is a
 * tombstone, and only while it is empty — `rmdirIfEmpty` refuses everything
 * else, which is what keeps a document a peer failed to remove (and a cloud
 * client's dot-staging directory, and anything the user filed in there by hand)
 * out of reach. The caller has already established that no LIVE canvas row owns
 * a document beneath it.
 *
 * Deepest first: `listCanvasFolderDirs` hands the candidates over parent-first,
 * and a parent cannot go until its own tombstoned children have.
 *
 * The cost of being wrong is an empty directory, and it is self-healing in both
 * directions: a folder whose canvases were still on their way comes back the
 * moment one of them lands (adoption revives the row, and writing a canvas file
 * re-creates its directory).
 *
 * @returns how many directories were removed.
 */
function pruneTombstonedFolderDirs(vaultPath: string, folders: string[]): number {
  let pruned = 0
  const deepestFirst = [...folders].sort(
    (a, b) => folderSegments(b).length - folderSegments(a).length
  )
  for (const folder of deepestFirst) {
    if (removeCanvasFolderDirIfEmpty(vaultPath, folder)) pruned += 1
  }
  return pruned
}

/** Rows still holding a legacy encrypted snapshot. */
function legacyRows(db: DataDb): {
  id: string
  title: string | null
  createdAt: number
  updatedAt: number
  snapshotCiphertext: string
}[] {
  return db
    .select({
      id: canvases.id,
      title: canvases.title,
      createdAt: canvases.createdAt,
      updatedAt: canvases.updatedAt,
      snapshotCiphertext: canvases.snapshotCiphertext
    })
    .from(canvases)
    .where(and(isNull(canvases.filePath), ne(canvases.snapshotCiphertext, '')))
    .all()
}

function hasLegacyLibraryRows(db: DataDb): boolean {
  return (
    db
      .select({ id: canvasLibraryItems.id })
      .from(canvasLibraryItems)
      .where(isNull(canvasLibraryItems.deletedAt))
      .limit(1)
      .get() !== undefined
  )
}

/**
 * Resolves the vault key ONLY when there is legacy ciphertext to migrate.
 * `getOrInitializeLocalVaultKey` mints a master key when the keychain has none,
 * so calling it on every vault open would create key material for vaults that
 * never needed any.
 */
async function tryResolveVaultKey(db: DataDb, vaultId: string): Promise<Uint8Array | null> {
  try {
    return await getLegacyCanvasVaultKey(db, vaultId)
  } catch (err) {
    log.warn('No vault key available for canvas migration; legacy rows stay unreadable', { err })
    return null
  }
}

export async function reconcileCanvasFiles(
  db: DataDb,
  vaultPath: string,
  /** Defaults to this vault's uuid; passed explicitly by tests. */
  vaultId: string = getOrCreateVaultUuid(db)
): Promise<CanvasReconcileResult> {
  const result: CanvasReconcileResult = {
    migrated: 0,
    unreadable: 0,
    adopted: 0,
    foldersAdopted: 0,
    foldersRestored: 0,
    foldersPruned: 0,
    missingFiles: 0,
    libraryItemsMigrated: 0
  }

  ensureCanvasDir(vaultPath)
  // Before anything reads a path: both the file walk and the directory walk below
  // hand their raw on-disk segments straight to a stored `folder`, and that
  // stored form has to be the canonical one.
  canonicalizeCanvasFolderDirs(vaultPath)

  const pending = legacyRows(db)
  const legacyLibrary = hasLegacyLibraryRows(db)
  const vaultKey =
    pending.length > 0 || legacyLibrary ? await tryResolveVaultKey(db, vaultId) : null

  // ---- 1. migrate legacy encrypted snapshots -------------------------------
  const claimed = new Set<string>()
  for (const row of pending) {
    if (!vaultKey) {
      result.unreadable += 1
      continue
    }
    let scene: string
    try {
      scene = decryptCanvasSceneForVault(row.snapshotCiphertext, vaultKey)
    } catch (err) {
      // The master key changed under this row. Keep the ciphertext: it is the
      // only copy, and it decrypts again if the old key is ever restored.
      log.error('Canvas snapshot cannot be decrypted with the current vault key', {
        id: row.id,
        err
      })
      // The PR #946 orphaned-canvas failure mode — a key-rebind recurrence
      // must aggregate in Error Tracking, not just in shipped log lines.
      trackMainError('canvas', 'legacy_snapshot_decrypt', err)
      result.unreadable += 1
      continue
    }

    const filePath = allocateCanvasPath(vaultPath, row.title, claimed)
    claimed.add(filePath)
    writeCanvasFileSync(
      resolveCanvasFile(vaultPath, filePath),
      withCanvasMeta(scene, { id: row.id, createdAt: row.createdAt, updatedAt: row.updatedAt })
    )
    db.update(canvases)
      .set({ filePath, snapshotCiphertext: '' })
      .where(eq(canvases.id, row.id))
      .run()
    result.migrated += 1
  }

  // ---- 2. migrate the legacy encrypted shapes library ----------------------
  if (legacyLibrary && vaultKey) {
    const rows = db
      .select({ id: canvasLibraryItems.id, itemCiphertext: canvasLibraryItems.itemCiphertext })
      .from(canvasLibraryItems)
      .where(isNull(canvasLibraryItems.deletedAt))
      .all()
    const items: CanvasLibraryItem[] = []
    for (const row of rows) {
      try {
        items.push(
          JSON.parse(
            decryptCanvasLibraryItemForVault(row.itemCiphertext, vaultKey)
          ) as CanvasLibraryItem
        )
      } catch (err) {
        log.warn('Skipping unreadable canvas library item', { id: row.id, err })
      }
    }
    if (items.length > 0) {
      // Merge rather than replace: the file may already hold items this device
      // saved after the migration shipped.
      const existing = readCanvasLibrary(vaultPath)
      const byId = new Map(existing.map((item) => [(item as { id?: string }).id, item]))
      for (const item of items) {
        const id = (item as { id?: string }).id
        if (id && !byId.has(id)) byId.set(id, item)
      }
      writeCanvasLibrary(vaultPath, [...byId.values()])
      result.libraryItemsMigrated = items.length
    }
    // Tombstone the rows so the migration does not run again; the ciphertext
    // column is left intact for the same "old key might return" reason.
    db.update(canvasLibraryItems)
      .set({ deletedAt: Date.now() })
      .where(isNull(canvasLibraryItems.deletedAt))
      .run()
  }

  // ---- 3. adopt files this index has never seen ----------------------------
  const indexed = db.select({ id: canvases.id, filePath: canvases.filePath }).from(canvases).all()
  // Which file each id is currently bound to. Kept up to date through the loop
  // so the duplicate check below sees the binding this very run just made.
  const boundPathById = new Map<string, string | null>(indexed.map((row) => [row.id, row.filePath]))
  const knownIds = new Set(indexed.map((row) => row.id))
  // Keyed case- and Unicode-insensitively: macOS hands back decomposed (NFD)
  // filenames for the composed (NFC) name we wrote, and both macOS and Windows
  // are case-insensitive. Comparing raw strings would make every vault open
  // rediscover the same documents as new.
  //
  // TOMBSTONED rows are in here on purpose, which is what makes a deleted canvas
  // stay deleted when its document comes back. Two situations put a file at a
  // tombstoned row's path and nothing here can tell them apart: the user
  // restoring it from the OS trash, and a removal that FAILED —
  // `deleteCanvasFileSync` is total, a peer's `applyDelete` removes the document
  // the same way on every other device, and a cloud client can re-materialize a
  // file mid-sync. Adopting would resurrect the canvas fleet-wide off a failed
  // unlink. The folder half has a second signal to separate the two (does a live
  // canvas row still own a document in there?); the canvas half has only the
  // file, so the delete wins. The delete confirmation says so.
  const knownPaths = new Set(
    indexed
      .map((row) => row.filePath)
      .filter(Boolean)
      .map((filePath) => canvasPathKey(filePath!))
  )

  // Kept: step 4 asks it which folders still hold documents, and nothing below
  // adds or removes a `.excalidraw` file (only sidecars are rewritten).
  const canvasFilesOnDisk = listCanvasFiles(vaultPath)

  for (const filePath of canvasFilesOnDisk) {
    if (knownPaths.has(canvasPathKey(filePath))) continue
    const content = readCanvasFileSync(resolveCanvasFile(vaultPath, filePath))
    if (content === null) continue

    const meta = readCanvasMeta(content)
    const now = Date.now()
    // The sidecar id lives INSIDE the file, so duplicating a canvas in Finder
    // (or a cloud client leaving a conflict copy) yields two files claiming one
    // id. Only a file whose id has NO live binding may take the row — otherwise
    // the row would follow whichever copy this run happened to reach last, and
    // the user's edits would split across two documents with neither complete.
    const boundPath = meta ? (boundPathById.get(meta.id) ?? null) : null
    const boundFileStillThere =
      boundPath !== null && existsSync(resolveCanvasFile(vaultPath, boundPath))
    if (meta && knownIds.has(meta.id) && !boundFileStillThere) {
      // Same canvas, moved or renamed outside the app — re-point the index
      // instead of minting a duplicate. The folder comes along: a drag into
      // (or out of) a subfolder in Finder is a real move, and a row left
      // pointing at the old folder would show the canvas where it is not.
      db.update(canvases)
        .set({ filePath, folder: folderOfCanvasPath(filePath) })
        .where(eq(canvases.id, meta.id))
        .run()
      boundPathById.set(meta.id, filePath)
      knownPaths.add(canvasPathKey(filePath))
      continue
    }

    // A duplicate takes a NEW id: what the user has is two documents, and
    // adopting the second one under a fresh identity is the only outcome that
    // keeps both editable and both syncable.
    const id = meta && !knownIds.has(meta.id) ? meta.id : generateId()
    const title = titleFromPath(filePath)
    db.insert(canvases)
      .values({
        id,
        vaultId,
        title,
        filePath,
        // Read back off the path, never guessed: where the file sits IS the
        // canvas's folder, and the path segments are already the on-disk
        // canonical ones.
        folder: folderOfCanvasPath(filePath),
        snapshotCiphertext: '',
        vectorClock: {},
        createdAt: meta?.createdAt ?? now,
        updatedAt: meta?.updatedAt ?? now,
        deletedAt: null,
        lastSyncedAt: null,
        // Null clock: seedUnclocked pushes it on the next sync, which is how an
        // adopted canvas reaches the user's other devices.
        clock: null
      })
      .onConflictDoNothing()
      .run()

    // A file dropped in by hand has no sidecar, and a duplicate's sidecar still
    // names the canvas it was copied from. Either way, stamp the id this row
    // actually holds: the file has to survive the next copy knowing which
    // document it is. Timestamps match what was just inserted.
    if (!meta || meta.id !== id) {
      writeCanvasFileSync(
        resolveCanvasFile(vaultPath, filePath),
        withCanvasMeta(stripCanvasMeta(content), {
          id,
          createdAt: meta?.createdAt ?? now,
          updatedAt: meta?.updatedAt ?? now
        })
      )
    }

    for (const ref of extractEntityRefsFromScene(stripCanvasMeta(content))) {
      db.insert(canvasEntityRefs)
        .values({ canvasId: id, entityType: ref.entityType, entityId: ref.entityId })
        .onConflictDoNothing()
        .run()
    }

    knownIds.add(id)
    boundPathById.set(id, filePath)
    knownPaths.add(canvasPathKey(filePath))
    result.adopted += 1
  }

  // ---- 4. adopt directories this index has never seen ----------------------
  // The directory is the truth for a folder's existence, so a folder that
  // arrived with a copied vault (or was made in Finder) has to reach the app —
  // including an EMPTY one, which no canvas row can carry.
  const folderRows = db
    .select({
      path: canvasFolders.path,
      deletedAt: canvasFolders.deletedAt,
      clock: canvasFolders.clock
    })
    .from(canvasFolders)
    .where(eq(canvasFolders.vaultId, vaultId))
    .all()
  // Keyed by the derived id, not the raw path, so an NFD directory name from
  // macOS matches the NFC row that already describes it.
  const folderRowById = new Map(folderRows.map((row) => [canvasFolderSyncId(row.path), row]))
  const liveFolderIds = new Set(
    folderRows.filter((row) => row.deletedAt === null).map((row) => canvasFolderSyncId(row.path))
  )
  // Documents a LIVE row owns — read after adoption, so every file this run just
  // took in counts. Keyed the same way `knownPaths` is, because the walk hands
  // back the on-disk bytes (NFD on macOS) for a path stored as NFC.
  const livePathKeys = new Set(
    db
      .select({ filePath: canvases.filePath })
      .from(canvases)
      .where(isNull(canvases.deletedAt))
      .all()
      .map((row) => row.filePath)
      .filter((filePath): filePath is string => Boolean(filePath))
      .map((filePath) => canvasPathKey(filePath))
  )
  /**
   * Does this folder still hold canvas documents a LIVE row owns, anywhere
   * beneath it?
   *
   * The one signal that separates the two things that leave a directory behind
   * for a tombstoned row — see the revival rule in the loop below.
   *
   * Ownership is the whole question, not mere presence. A peer's folder delete
   * tombstones the canvas ROWS too, and removing a canvas file can fail (a
   * locked file, a refused trash) — so the directory can be full of documents
   * that every device already considers deleted. Counting those would revive,
   * fleet wide, exactly the folder the user deleted.
   */
  const holdsDocuments = (folder: string): boolean =>
    canvasFilesOnDisk.some(
      (filePath) =>
        livePathKeys.has(canvasPathKey(filePath)) &&
        isDescendantFolder(folderOfCanvasPath(filePath), folder)
    )

  /** Directories of already-deleted folders, for the sweep in 4a. */
  const emptiedByDelete: string[] = []

  for (const folder of listCanvasFolderDirs(vaultPath)) {
    // The invariant, enforced at the one place a directory becomes a row: what
    // gets stored is the on-disk-canonical form. `canonicalizeCanvasFolderDirs`
    // has already renamed everything it could, so anything still non-canonical
    // is a directory whose rename was refused — indexing it under a path no
    // later lookup resolves would be worse than leaving it unindexed.
    if (portableCanvasFolder(folder) !== folder) continue
    const id = canvasFolderSyncId(folder)
    if (liveFolderIds.has(id)) continue
    // A row already holding this id can only be a tombstone (a live one was
    // filtered out above).
    const tombstone = folderRowById.get(id)

    // **The revival rule.** A directory whose row is a tombstone comes back only
    // when it still holds a document a LIVE canvas row owns.
    //
    // The delete is already on the wire, so re-adopting one that does not is how
    // "the user deletes a folder on their Mac and it reappears on their Windows
    // machine" happens: a remote folder delete tombstones the row, and the
    // emptied directory can outlive it whenever the canvas deletes had not
    // applied yet when `canvas-folder-handler.applyDelete` reached for it. The
    // same state comes from a local `deleteCanvasFolder` whose trash was refused
    // — it tombstones the canvas rows too — and the two are indistinguishable
    // from here, so both take the answer that respects the delete.
    //
    // Ownership rather than mere presence, because removing a canvas file can
    // FAIL on either side of that delete: a directory full of documents whose
    // rows are all tombstoned is exactly the folder that should stay deleted.
    //
    // The directory is a candidate for the sweep below rather than adoption —
    // the user deleted this folder, so an emptied directory left where it stands
    // is litter in their vault. Nothing is taken from it: only the directory
    // itself, and only while it holds nothing at all. See
    // `pruneTombstonedFolderDirs`.
    if (tombstone && !holdsDocuments(folder)) {
      emptiedByDelete.push(folder)
      continue
    }

    const now = Date.now()
    db.insert(canvasFolders)
      .values({
        id,
        vaultId,
        path: folder,
        icon: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        // Null clock: seedUnclocked pushes it on the next sync, which is how an
        // adopted folder reaches the user's other devices.
        clock: null
      })
      // The id is derived from the path, so a tombstoned folder still occupies
      // it and a plain insert would fail on the primary key. Revive instead —
      // the rule above has already established this one earned it. `createdAt`
      // and `clock` are left alone: the folder is the same one it always was.
      .onConflictDoUpdate({
        target: canvasFolders.id,
        set: { vaultId, path: folder, deletedAt: null, updatedAt: now }
      })
      .run()
    liveFolderIds.add(id)
    result.foldersAdopted += 1

    // A revival that got this far is one the rule above allowed, and it is a
    // local mutation — so it has to reach the other devices, or the folder is
    // back here and gone everywhere else and the next pull undoes it. Enqueued
    // exactly the way `folder-store`'s mutations are (the queue bumps the clock;
    // the offline fallback bumps it in place when the sync runtime is not up).
    //
    // A row with no clock is the one revival kept off the wire: the server has
    // never seen it, so an `update` has nothing to update — and any clock bump
    // takes it out of `seedUnclocked`'s reach, which is the very thing that
    // would have pushed it as a create.
    if (tombstone && tombstone.clock !== null) {
      enqueueLocalSyncUpdate('canvas_folder', id)
    }
  }

  // ---- 4a. sweep up the directory of a folder that is already deleted -------
  // The retry for the `rmdir` the sync apply order regularly finds occupied.
  result.foldersPruned = pruneTombstonedFolderDirs(vaultPath, emptiedByDelete)

  // ---- 4b. put back the directory of a folder row that has none ------------
  // Never a tombstone (see `restoreMissingFolderDirs`), and never a row this
  // very run just adopted or revived — those have their directory by definition,
  // which is what found them.
  result.foldersRestored = restoreMissingFolderDirs(vaultPath, folderRows)

  // ---- 5. report (never delete) rows whose file vanished -------------------
  // Re-read rather than reusing the pre-adoption snapshot: adoption re-points a
  // row when its file moved or was renamed in Finder, and the stale snapshot
  // still holds the path the file just left — which would report a phantom
  // missing document (and an `unreadable` canvas) after every such move.
  //
  // Tombstones are excluded, and that is the point of the count: `deleteCanvas`
  // tombstones the row but LEAVES `file_path` populated (the row stays the sync
  // truth) after trashing the document. Counting those would re-report every
  // canvas the user has ever deleted, on every vault open, forever — and this
  // number ships as a fleet-health metric for half-copied vaults.
  const currentPaths = db
    .select({ id: canvases.id, filePath: canvases.filePath })
    .from(canvases)
    .where(isNull(canvases.deletedAt))
    .all()
  for (const row of currentPaths) {
    if (!row.filePath) continue
    if (readCanvasFileSync(resolveCanvasFile(vaultPath, row.filePath)) === null) {
      result.missingFiles += 1
    }
  }

  if (
    result.migrated ||
    result.unreadable ||
    result.adopted ||
    result.foldersAdopted ||
    result.foldersRestored ||
    result.foldersPruned ||
    result.missingFiles ||
    result.libraryItemsMigrated
  ) {
    log.info('Canvas files reconciled', result)
  }
  // Unreadable rows and vanished files are the fleet-health signals for the
  // orphaned-canvas and half-copied-vault failure modes; info logs never ship,
  // so emit their counts as warn metrics.
  if (result.unreadable > 0) {
    trackMainLog('warn', {
      scope: 'CanvasReconcile',
      action: 'reconcile_unreadable',
      metrics: { itemCount: result.unreadable }
    })
  }
  if (result.missingFiles > 0) {
    trackMainLog('warn', {
      scope: 'CanvasReconcile',
      action: 'reconcile_missing_files',
      metrics: { itemCount: result.missingFiles }
    })
  }
  return result
}

function titleFromPath(filePath: string): string {
  // Case-insensitive extension strip: a `.EXCALIDRAW` file copied from a
  // Windows vault must not keep the extension in its title.
  const base = filePath.split(/[\\/]/).pop() ?? filePath
  return base.replace(/\.excalidraw$/i, '')
}
