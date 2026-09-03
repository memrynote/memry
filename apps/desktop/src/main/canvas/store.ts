/**
 * Canvas store — the canvases + canvas_entity_refs index over the vault's
 * `.excalidraw` files.
 *
 * The FILE is the source of truth for ink (`canvas/scene-file.ts`); this table
 * carries identity, title, timestamps and sync state. Nothing here needs the
 * vault key, which is the whole point: a canvas opens after the vault folder is
 * copied to another machine and after a local-only user upgrades to a sync
 * account (both replace the master key).
 *
 * Lives outside main/ipc so canvas-handlers.ts satisfies the architecture
 * boundary (no direct query imports from the ipc layer); mirrors
 * main/bookmarks/store.ts. The vault path is a parameter so the store stays
 * testable without an open vault.
 *
 * Deletes are soft (deletedAt tombstone) — canvas rows must stay visible to
 * the sync layer; see the spatial-canvas spec §5.4. The document goes to the OS
 * trash on delete (plain unlink as a fallback): a tombstoned canvas must not
 * keep haunting the user's folder, but a mis-click should still be recoverable.
 *
 * Placement is indexed here too (`folder`), and the FILE's location is the
 * truth for it — so the folder this store writes is always the on-disk
 * canonical one, read back out of the allocated path, never the string a caller
 * asked for.
 */

import { and, count, desc, eq, isNull } from 'drizzle-orm'
import {
  canvasAssets,
  canvases,
  canvasEntityRefs,
  type CanvasRow
} from '@memry/db-schema/data-schema'
import type {
  Canvas,
  CanvasSummary,
  CanvasSummaryWithCount,
  CanvasEntityRef,
  CanvasUpdateFailure
} from '@memry/contracts/canvas-api'
import type { DataDb } from '../database'
import { generateId } from '../lib/id'
import { createLogger } from '../lib/logger'
import { storedFolderPath } from './folder-lookup'
import { normalizeFolder, normalizeStoredFolder } from './folder-paths'
import {
  allocateCanvasPath,
  CANVAS_FILE_EXT,
  deleteCanvasFileSync,
  folderOfCanvasPath,
  readCanvasFileSync,
  renameCanvasFile,
  resolveCanvasFile,
  stripCanvasMeta,
  withCanvasMeta,
  writeCanvasFileSync
} from './scene-file'

const log = createLogger('CanvasStore')

export interface CanvasCreateInput {
  title?: string | null
  scene?: string
  /**
   * Where to put the canvas, relative to `canvases/`. Null/absent is the root.
   * Sanitized on the way to disk, so the folder that ends up STORED is the
   * canonical on-disk one — see `createCanvas`.
   */
  folder?: string | null
  icon?: string | null
}

export interface CanvasUpdateInput {
  title?: string | null
  scene?: string
  /** Move the canvas. Null moves it to the root; absent leaves it where it is. */
  folder?: string | null
  icon?: string | null
  entityRefs?: CanvasEntityRef[]
  /** Optimistic guard — see CanvasUpdateSchema. */
  expectedUpdatedAt?: number
}

export type CanvasUpdateResult =
  { ok: true; summary: CanvasSummary } | { ok: false; reason: CanvasUpdateFailure }

function toSummary(
  row: Pick<CanvasRow, 'id' | 'title' | 'folder' | 'icon' | 'createdAt' | 'updatedAt'>
): CanvasSummary {
  return {
    id: row.id,
    title: row.title,
    folder: row.folder ?? null,
    icon: row.icon ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

/**
 * Writes the canvas document, embedding the memry sidecar so a single copied
 * file still knows which canvas it is.
 */
export function writeCanvasScene(
  vaultPath: string,
  relativePath: string,
  id: string,
  scene: string,
  createdAt: number,
  updatedAt: number
): void {
  writeCanvasFileSync(
    resolveCanvasFile(vaultPath, relativePath),
    withCanvasMeta(scene, { id, createdAt, updatedAt })
  )
}

/** The scene as everything outside this module sees it (no memry sidecar). */
export function readCanvasScene(vaultPath: string, relativePath: string | null): string | null {
  if (!relativePath) return null
  const content = readCanvasFileSync(resolveCanvasFile(vaultPath, relativePath))
  if (content === null) return null
  return stripCanvasMeta(content)
}

export function createCanvas(
  db: DataDb,
  vaultPath: string,
  vaultId: string,
  input: CanvasCreateInput
): Canvas {
  const id = generateId()
  const now = Date.now()
  const scene = input.scene ?? ''
  // Resolved through the folder index, not taken as typed: a caller asking for
  // `work` when the folder row spells it `Work` must land in that one directory,
  // not mint a second one on a case-sensitive filesystem. Still strict, so an
  // over-deep folder is refused before anything is written. The directory itself
  // is NOT created here — `writeCanvasScene` below mkdirs the file's parent, so a
  // separate ensure would only leave an empty directory behind when the write
  // fails, which the next reconcile would adopt as a folder nobody made.
  const requestedFolder = storedFolderPath(db, input.folder ?? null)
  const filePath = allocateCanvasPath(
    vaultPath,
    input.title ?? null,
    new Set(),
    null,
    requestedFolder
  )
  // The folder we STORE is read back out of the allocated path, never echoed
  // from the input: `allocateCanvasPath` sanitizes each segment, so a folder
  // asked for as `CON` lives on disk as `CON canvas`. A row holding `CON` would
  // point the index at a directory that does not exist.
  const folder = folderOfCanvasPath(filePath)
  const icon = input.icon ?? null

  writeCanvasScene(vaultPath, filePath, id, scene, now, now)

  db.insert(canvases)
    .values({
      id,
      vaultId,
      title: input.title ?? null,
      filePath,
      folder,
      icon,
      snapshotCiphertext: '',
      vectorClock: {},
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      lastSyncedAt: null,
      clock: null
    })
    .run()

  return {
    id,
    title: input.title ?? null,
    folder,
    icon,
    createdAt: now,
    updatedAt: now,
    // Read back rather than echoing the input: callers must see the same
    // normalized text `getCanvas` will hand them, or the editor's save dedupe
    // fires an extra write on the first change.
    scene: readCanvasScene(vaultPath, filePath) ?? scene
  }
}

/**
 * Copy a canvas into a new one beside it (same folder, same icon).
 *
 * The `canvas_assets` rows are copied too, and that is not optional: asset GC
 * (`assets/dedup-plan.ts`) decides a contentHash is orphaned when no OTHER
 * canvas references it. A duplicate whose scene shows images but whose rows are
 * missing would make the ORIGINAL's next save dereference those chunks on the
 * server — breaking the copy silently, and later.
 */
export function duplicateCanvas(
  db: DataDb,
  vaultPath: string,
  vaultId: string,
  id: string
): Canvas | null {
  const row = db
    .select()
    .from(canvases)
    .where(and(eq(canvases.id, id), isNull(canvases.deletedAt)))
    .get()
  if (!row) return null

  const scene = readCanvasScene(vaultPath, row.filePath)
  // Refuse to duplicate ink we cannot read: the copy would be an empty canvas
  // wearing the original's name.
  if (scene === null) {
    log.warn('Refusing to duplicate a canvas with no readable document', { id })
    return null
  }

  // Allocate first so the copy's TITLE matches the filename it will get
  // ("Plan" beside "Plan" becomes "Plan 2"), instead of two rows sharing a
  // label while the sidebar and the vault folder disagree. An untitled canvas
  // stays untitled — there is no label to keep in step.
  // The STRICT normalizer, unlike the read/update paths below: a duplicate is a
  // NEW canvas, and one filed past the depth cap would be a document
  // `listCanvasFiles` never walks to. `allocateCanvasPath` refuses it a layer
  // down anyway, so this is the same answer said earlier and more clearly.
  const folder = normalizeFolder(row.folder)
  // Stored paths are always forward-slashed, on every platform.
  const copyFilename = allocateCanvasPath(vaultPath, row.title, new Set(), null, folder)
    .split('/')
    .pop()!
  const copyTitle = row.title === null ? null : copyFilename.slice(0, -CANVAS_FILE_EXT.length)

  const created = createCanvas(db, vaultPath, vaultId, {
    title: copyTitle,
    folder,
    icon: row.icon,
    scene
  })

  for (const asset of db.select().from(canvasAssets).where(eq(canvasAssets.canvasId, id)).all()) {
    db.insert(canvasAssets)
      .values({ ...asset, canvasId: created.id })
      .onConflictDoNothing()
      .run()
  }

  return created
}

export function getCanvas(db: DataDb, vaultPath: string, id: string): Canvas | null {
  const row = db
    .select()
    .from(canvases)
    .where(and(eq(canvases.id, id), isNull(canvases.deletedAt)))
    .get()
  if (!row) return null

  const scene = readCanvasScene(vaultPath, row.filePath)
  if (scene === null) {
    // Either a legacy row whose ciphertext could not be migrated (no key), or a
    // file the user moved/deleted outside the app. Report it instead of
    // returning an empty scene, which the editor would happily overwrite the
    // moment the user clicks — that would turn "unreadable" into "erased".
    return { ...toSummary(row), scene: '', unreadable: true }
  }

  return { ...toSummary(row), scene }
}

export function updateCanvas(
  db: DataDb,
  vaultPath: string,
  id: string,
  input: CanvasUpdateInput
): CanvasUpdateResult {
  return db.transaction((tx) => {
    const row = tx
      .select()
      .from(canvases)
      .where(and(eq(canvases.id, id), isNull(canvases.deletedAt)))
      .get()
    if (!row) return { ok: false, reason: 'not-found' } as const

    // Compared inside the transaction on purpose: the same check outside it
    // would be the identical lost-update race wearing a longer coat.
    if (input.expectedUpdatedAt !== undefined && row.updatedAt !== input.expectedUpdatedAt) {
      return { ok: false, reason: 'conflict' } as const
    }

    // An unmigrated legacy row has no file. Refuse the write rather than mint a
    // fresh empty document over ink we may still recover with the old key.
    if (!row.filePath) return { ok: false, reason: 'not-found' } as const

    const now = Date.now()
    // Not const: a move into a folder that already holds this title lands the
    // file on `Plan 2.excalidraw`, and the label follows it — see below.
    let nextTitle = input.title !== undefined ? input.title : row.title
    // Strict for what the caller asked for, total for what the row already
    // holds: a canvas stored past the depth cap has to stay editable — and
    // movable back out — instead of throwing the moment it is opened.
    //
    // A requested folder is resolved through the folder index (the same helper
    // `folder-store` uses), so both tables spell one directory one way. Without
    // it a move asked for as `work` stored `work` while the folder row — and, on
    // Linux, the only directory that exists — said `Work`, and the canvas
    // vanished from its own folder in the tree.
    const nextFolder =
      input.folder !== undefined
        ? storedFolderPath(tx, input.folder)
        : normalizeStoredFolder(row.folder)
    const changes: Partial<typeof canvases.$inferInsert> = { updatedAt: now }
    if (input.title !== undefined) changes.title = input.title
    // Drizzle wants an explicit null in .set(); undefined would be dropped and
    // "clear the icon" would silently become "leave the icon alone".
    if (input.icon !== undefined) changes.icon = input.icon ?? null
    if (input.folder !== undefined) changes.folder = nextFolder

    // Keep the file tracking the title AND the placement, the way a renamed
    // note follows its heading. A failed move keeps the old path — never lose
    // the file.
    let filePath = row.filePath
    const titleChanged = input.title !== undefined && input.title !== row.title
    const folderChanged =
      input.folder !== undefined && nextFolder !== normalizeStoredFolder(row.folder)
    if (titleChanged || folderChanged) {
      // No ensure-the-directory step: `renameCanvasFile` mkdirs the target's
      // parent itself, and creating it up front would leave an empty directory
      // behind whenever the rename fails — a folder the next reconcile adopts
      // even though the canvas never got there.
      const target = allocateCanvasPath(vaultPath, nextTitle, new Set(), row.filePath, nextFolder)
      filePath = renameCanvasFile(vaultPath, row.filePath, target)
      if (filePath !== row.filePath) changes.filePath = filePath
      // The move may have failed, and the stored folder must describe where the
      // file actually IS — otherwise every later lookup by folder misses it.
      // Reading it back also canonicalizes it (`CON` → `CON canvas`).
      changes.folder = folderOfCanvasPath(filePath)
      // And the title follows the filename it landed on, exactly the way
      // `duplicateCanvas` names a copy: `allocateCanvasPath` uniquifies PER
      // folder, so moving a second `Plan` into `Work` writes `Plan 2`, and a row
      // still labelled `Plan` would leave two LIVE canvases sharing one name in
      // one folder — a pair the sidebar cannot tell apart and an agent cannot
      // address at all (`resolveCanvasId` refuses the name as ambiguous and
      // offers two identical candidates). `reconcile` already titles an adopted
      // canvas from its filename, so this is the index agreeing with what a
      // fresh scan would say.
      //
      // Only when the file actually moved: a failed rename keeps the old path,
      // and the title the user typed must not be dragged back with it. An
      // untitled canvas stays untitled — there is no label to keep in step.
      if (filePath !== row.filePath && nextTitle !== null) {
        // Stored paths are always forward-slashed, on every platform.
        nextTitle = filePath.split('/').pop()!.slice(0, -CANVAS_FILE_EXT.length)
        changes.title = nextTitle
      }
    }

    if (input.scene !== undefined) {
      writeCanvasScene(vaultPath, filePath, id, input.scene, row.createdAt, now)
    } else if (changes.filePath !== undefined) {
      // Title-only change: refresh the sidecar's updatedAt in the moved file.
      const current = readCanvasScene(vaultPath, filePath)
      if (current !== null) {
        writeCanvasScene(vaultPath, filePath, id, current, row.createdAt, now)
      }
    }

    tx.update(canvases).set(changes).where(eq(canvases.id, id)).run()

    if (input.entityRefs !== undefined) {
      tx.delete(canvasEntityRefs).where(eq(canvasEntityRefs.canvasId, id)).run()
      for (const ref of input.entityRefs) {
        tx.insert(canvasEntityRefs)
          .values({ canvasId: id, entityType: ref.entityType, entityId: ref.entityId })
          .onConflictDoNothing()
          .run()
      }
    }

    return {
      ok: true,
      summary: toSummary({
        ...row,
        title: nextTitle,
        // `??` would be wrong here: null is a real value (root / no icon).
        folder: changes.folder !== undefined ? changes.folder : row.folder,
        icon: changes.icon !== undefined ? changes.icon : row.icon,
        updatedAt: now
      })
    } as const
  })
}

/**
 * Vault-relative path of a live canvas's document, for the reveal / open-in-
 * external-app handlers. Null for a missing, tombstoned, or unmigrated-legacy
 * canvas — all three have no file to point at.
 */
export function getCanvasFilePath(db: DataDb, id: string): string | null {
  const row = db
    .select({ filePath: canvases.filePath })
    .from(canvases)
    .where(and(eq(canvases.id, id), isNull(canvases.deletedAt)))
    .get()
  return row?.filePath ?? null
}

/**
 * Tombstones the canvas and sends its document to the OS trash.
 *
 * `trash` is injected (rather than importing electron's `shell`) so the store
 * stays testable without an electron runtime, matching the rest of this module.
 */
export async function deleteCanvas(
  db: DataDb,
  vaultPath: string,
  id: string,
  trash: (absolutePath: string) => Promise<void>
): Promise<boolean> {
  const filePath = db.transaction((tx) => {
    const row = tx
      .select({ id: canvases.id, filePath: canvases.filePath })
      .from(canvases)
      .where(and(eq(canvases.id, id), isNull(canvases.deletedAt)))
      .get()
    if (!row) return null

    const now = Date.now()
    tx.update(canvases).set({ deletedAt: now, updatedAt: now }).where(eq(canvases.id, id)).run()
    // The FK cascade only fires on hard deletes; prune advisory refs here so
    // ref-consuming queries never see tombstoned canvases.
    tx.delete(canvasEntityRefs).where(eq(canvasEntityRefs.canvasId, id)).run()
    return row.filePath ?? ''
  })

  if (filePath === null) return false
  // Outside the transaction: an fs failure must not roll back the tombstone
  // (that would resurrect the canvas), and the row is the sync source of truth.
  if (filePath) {
    const absolutePath = resolveCanvasFile(vaultPath, filePath)
    try {
      await trash(absolutePath)
    } catch (err) {
      // Trash can be unavailable (network volumes, some Linux setups). The
      // tombstone already stands; fall back to a plain unlink so a deleted
      // canvas does not keep haunting the user's folder.
      log.warn('Could not trash canvas file; falling back to unlink', {
        code: (err as NodeJS.ErrnoException).code
      })
      deleteCanvasFileSync(absolutePath)
    }
  }
  return true
}

export function listCanvases(db: DataDb, vaultId: string): CanvasSummary[] {
  return db
    .select({
      id: canvases.id,
      title: canvases.title,
      folder: canvases.folder,
      icon: canvases.icon,
      createdAt: canvases.createdAt,
      updatedAt: canvases.updatedAt
    })
    .from(canvases)
    .where(and(eq(canvases.vaultId, vaultId), isNull(canvases.deletedAt)))
    .orderBy(desc(canvases.updatedAt))
    .all()
    .map(toSummary)
}

/**
 * Like listCanvases, plus how many entities each canvas holds. Counted from the
 * advisory canvas_entity_refs rows (maintained on every save and on every sync
 * apply) rather than by reading every scene file, so listing stays cheap. Left
 * join so a canvas with no cards still appears, with a count of 0.
 */
export function listCanvasesWithCounts(db: DataDb, vaultId: string): CanvasSummaryWithCount[] {
  return db
    .select({
      id: canvases.id,
      title: canvases.title,
      folder: canvases.folder,
      icon: canvases.icon,
      createdAt: canvases.createdAt,
      updatedAt: canvases.updatedAt,
      itemCount: count(canvasEntityRefs.entityId)
    })
    .from(canvases)
    .leftJoin(canvasEntityRefs, eq(canvasEntityRefs.canvasId, canvases.id))
    .where(and(eq(canvases.vaultId, vaultId), isNull(canvases.deletedAt)))
    .groupBy(canvases.id)
    .orderBy(desc(canvases.updatedAt))
    .all()
}
