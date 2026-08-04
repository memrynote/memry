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
 * the sync layer; see the spatial-canvas spec §5.4. The file is removed on
 * delete: a tombstoned canvas must not keep haunting the user's folder.
 */

import { and, count, desc, eq, isNull } from 'drizzle-orm'
import { canvases, canvasEntityRefs, type CanvasRow } from '@memry/db-schema/data-schema'
import type {
  Canvas,
  CanvasSummary,
  CanvasSummaryWithCount,
  CanvasEntityRef,
  CanvasUpdateFailure
} from '@memry/contracts/canvas-api'
import type { DataDb } from '../database'
import { generateId } from '../lib/id'
import {
  allocateCanvasPath,
  deleteCanvasFileSync,
  readCanvasFileSync,
  renameCanvasFile,
  resolveCanvasFile,
  stripCanvasMeta,
  withCanvasMeta,
  writeCanvasFileSync
} from './scene-file'

export interface CanvasCreateInput {
  title?: string | null
  scene?: string
}

export interface CanvasUpdateInput {
  title?: string | null
  scene?: string
  entityRefs?: CanvasEntityRef[]
  /** Optimistic guard — see CanvasUpdateSchema. */
  expectedUpdatedAt?: number
}

export type CanvasUpdateResult =
  | { ok: true; summary: CanvasSummary }
  | { ok: false; reason: CanvasUpdateFailure }

function toSummary(
  row: Pick<CanvasRow, 'id' | 'title' | 'createdAt' | 'updatedAt'>
): CanvasSummary {
  return {
    id: row.id,
    title: row.title,
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
  const filePath = allocateCanvasPath(vaultPath, input.title ?? null)

  writeCanvasScene(vaultPath, filePath, id, scene, now, now)

  db.insert(canvases)
    .values({
      id,
      vaultId,
      title: input.title ?? null,
      filePath,
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
    createdAt: now,
    updatedAt: now,
    // Read back rather than echoing the input: callers must see the same
    // normalized text `getCanvas` will hand them, or the editor's save dedupe
    // fires an extra write on the first change.
    scene: readCanvasScene(vaultPath, filePath) ?? scene
  }
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
    const nextTitle = input.title !== undefined ? input.title : row.title
    const changes: Partial<typeof canvases.$inferInsert> = { updatedAt: now }
    if (input.title !== undefined) changes.title = input.title

    // Keep the filename tracking the title, the way a renamed note follows its
    // heading. A failed rename keeps the old path — never lose the file.
    let filePath = row.filePath
    if (input.title !== undefined && input.title !== row.title) {
      const target = allocateCanvasPath(vaultPath, nextTitle, new Set(), row.filePath)
      filePath = renameCanvasFile(vaultPath, row.filePath, target)
      if (filePath !== row.filePath) changes.filePath = filePath
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
      summary: toSummary({ ...row, title: nextTitle, updatedAt: now })
    } as const
  })
}

export function deleteCanvas(db: DataDb, vaultPath: string, id: string): boolean {
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
  if (filePath) deleteCanvasFileSync(resolveCanvasFile(vaultPath, filePath))
  return true
}

export function listCanvases(db: DataDb, vaultId: string): CanvasSummary[] {
  return db
    .select({
      id: canvases.id,
      title: canvases.title,
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
