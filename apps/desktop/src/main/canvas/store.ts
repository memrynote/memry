/**
 * Canvas store — drizzle CRUD for the canvases + canvas_entity_refs tables.
 *
 * Lives outside main/ipc so canvas-handlers.ts satisfies the architecture
 * boundary (no direct query imports from the ipc layer); mirrors
 * main/bookmarks/store.ts. All functions take the vault key as a parameter so
 * they stay testable without the keychain.
 *
 * Deletes are soft (deletedAt tombstone) — canvas rows must stay visible to
 * the future sync layer; see the spatial-canvas spec §5.4.
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
import { decryptCanvasSceneForVault, encryptCanvasSceneForVault } from './encryption'

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

export function createCanvas(
  db: DataDb,
  vaultKey: Uint8Array,
  vaultId: string,
  input: CanvasCreateInput
): Canvas {
  const id = generateId()
  const now = Date.now()
  const scene = input.scene ?? ''

  db.insert(canvases)
    .values({
      id,
      vaultId,
      title: input.title ?? null,
      snapshotCiphertext: encryptCanvasSceneForVault(scene, vaultKey),
      vectorClock: {},
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      lastSyncedAt: null,
      clock: null
    })
    .run()

  return { id, title: input.title ?? null, createdAt: now, updatedAt: now, scene }
}

export function getCanvas(db: DataDb, vaultKey: Uint8Array, id: string): Canvas | null {
  const row = db
    .select()
    .from(canvases)
    .where(and(eq(canvases.id, id), isNull(canvases.deletedAt)))
    .get()
  if (!row) return null

  return {
    ...toSummary(row),
    scene: decryptCanvasSceneForVault(row.snapshotCiphertext, vaultKey)
  }
}

export function updateCanvas(
  db: DataDb,
  vaultKey: Uint8Array,
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

    const now = Date.now()
    const changes: Partial<typeof canvases.$inferInsert> = { updatedAt: now }
    if (input.title !== undefined) changes.title = input.title
    if (input.scene !== undefined) {
      changes.snapshotCiphertext = encryptCanvasSceneForVault(input.scene, vaultKey)
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
      summary: toSummary({ ...row, title: changes.title ?? row.title, updatedAt: now })
    } as const
  })
}

export function deleteCanvas(db: DataDb, id: string): boolean {
  return db.transaction((tx) => {
    const row = tx
      .select({ id: canvases.id })
      .from(canvases)
      .where(and(eq(canvases.id, id), isNull(canvases.deletedAt)))
      .get()
    if (!row) return false

    const now = Date.now()
    tx.update(canvases).set({ deletedAt: now, updatedAt: now }).where(eq(canvases.id, id)).run()
    // The FK cascade only fires on hard deletes; prune advisory refs here so
    // ref-consuming queries never see tombstoned canvases.
    tx.delete(canvasEntityRefs).where(eq(canvasEntityRefs.canvasId, id)).run()
    return true
  })
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
 * apply) rather than by decrypting every scene, so listing stays cheap. Left
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
