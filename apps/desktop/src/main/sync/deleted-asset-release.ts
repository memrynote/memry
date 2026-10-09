/**
 * Frees the stored assets of a deleted note or canvas once the grace period
 * after its delete has passed (#3015).
 *
 * A delete keeps the item's images and attachments, so a restore from the OS
 * trash brings them back (#3002, #3012). This module ends that wait: 30 days
 * after this device deleted the item, it dereferences the item's server chunks
 * through `/sync/attachments/dereference` unless an item this device can still
 * see references the same asset. The server's chunk GC then deletes the bytes,
 * and the dereference that frees a chunk refunds its storage quota.
 *
 * Only the device that raised the delete records it. A delete applied from a
 * peer records nothing, so each delete is freed once. The record is a row in
 * `deleted_asset_releases`, so the grace period survives restarts.
 *
 * What counts as still referenced:
 * - a live note's attachment references or its own file attachment;
 * - an image in a live canvas's scene on disk (a canvas restored from the trash
 *   comes back under a new id and may have no asset rows yet);
 * - the asset rows of a canvas deleted less than the grace period ago, here or
 *   on a peer, so that canvas can still be restored;
 * - the attachments of a note this device deleted less than the grace period ago.
 *
 * Idempotent: the row goes only after the server confirmed the dereference.
 * A crash in between replays the same hashes, and the server floors each count
 * at zero, so a replay frees nothing twice.
 */

import { rm } from 'node:fs/promises'
import { and, eq, gt, inArray, isNull, lte } from 'drizzle-orm'
import { canvasAssets, canvases, deletedAssetReleases, noteMetadata } from '@memry/db-schema'
import { getDatabase, type DataDb } from '../database'
import { canvasAssetDiskPath } from '../canvas/assets/asset-service'
import { ASSET_RELEASE_GRACE_MS } from '../canvas/assets/asset-store'
import { contentHashFromRef, extractSceneFileRefs } from '../canvas/assets/memry-assets'
import { readCanvasScene } from '../canvas/store'
import { createLogger } from '../lib/logger'

const log = createLogger('DeletedAssetRelease')

export interface AssetReleaseDeps {
  db: DataDb
  vaultPath: string
  now: () => number
  /** The server chunk hashes of an attachment; `[]` when the server has none. Throws on failure. */
  chunkHashesOf: (attachmentId: string) => Promise<string[]>
  /** Decrement the server ref_count of these chunks. Never throws. */
  dereference: (chunkHashes: string[]) => Promise<{ ok: boolean }>
  markWritebackIgnored: (absolutePath: string) => void
}

/**
 * Record a delete this device raised. Called before the note's metadata row is
 * removed, so its attachment ids can still be read.
 */
export function recordDeletedItemAssets(
  db: DataDb,
  itemType: 'note' | 'canvas',
  itemId: string,
  now = Date.now()
): void {
  let attachmentIds: string[] | null = null
  if (itemType === 'note') {
    const note = db
      .select({ refs: noteMetadata.attachmentReferences, own: noteMetadata.attachmentId })
      .from(noteMetadata)
      .where(eq(noteMetadata.id, itemId))
      .get()
    attachmentIds = [...new Set([...(note?.refs ?? []), ...(note?.own ? [note.own] : [])])]
    if (attachmentIds.length === 0) return
  } else {
    const hasAssets = db
      .select({ id: canvasAssets.canvasId })
      .from(canvasAssets)
      .where(eq(canvasAssets.canvasId, itemId))
      .get()
    if (!hasAssets) return
  }
  db.insert(deletedAssetReleases)
    .values({ itemType, itemId, deletedAt: now, attachmentIds })
    .onConflictDoUpdate({
      target: [deletedAssetReleases.itemType, deletedAssetReleases.itemId],
      set: { deletedAt: now, attachmentIds }
    })
    .run()
}

/**
 * The delete paths' entry point: `syncNoteDelete` and `syncCanvasDelete`, which
 * every delete this device raises goes through (in the app, outside the app,
 * through the agent). A failure is logged and only costs the later freeing.
 */
export function recordLocalItemDelete(itemType: 'note' | 'canvas', itemId: string): void {
  try {
    recordDeletedItemAssets(getDatabase(), itemType, itemId)
  } catch (error) {
    log.warn('Could not record a deleted item for asset release', { itemType, error })
  }
}

interface References {
  contentHashes: Set<string>
  attachmentIds: Set<string>
}

/** Every asset an item this device can see, or can still restore, references. */
function stillReferenced(db: DataDb, vaultPath: string, graceStart: number): References {
  const contentHashes = new Set<string>()
  const attachmentIds = new Set<string>()

  for (const note of db
    .select({ refs: noteMetadata.attachmentReferences, own: noteMetadata.attachmentId })
    .from(noteMetadata)
    .all()) {
    for (const id of note.refs ?? []) attachmentIds.add(id)
    if (note.own) attachmentIds.add(note.own)
  }

  for (const release of db
    .select({ ids: deletedAssetReleases.attachmentIds })
    .from(deletedAssetReleases)
    .where(
      and(eq(deletedAssetReleases.itemType, 'note'), gt(deletedAssetReleases.deletedAt, graceStart))
    )
    .all()) {
    for (const id of release.ids ?? []) attachmentIds.add(id)
  }

  const liveCanvases = db
    .select({ id: canvases.id, filePath: canvases.filePath })
    .from(canvases)
    .where(isNull(canvases.deletedAt))
    .all()
  const unreadable: string[] = []
  for (const canvas of liveCanvases) {
    const scene = readCanvasScene(vaultPath, canvas.filePath)
    if (scene === null) {
      unreadable.push(canvas.id)
      continue
    }
    for (const { ref } of extractSceneFileRefs(scene)) {
      const hash = contentHashFromRef(ref)
      if (hash) contentHashes.add(hash)
    }
  }

  // A canvas still in its grace period has no scene on disk to read, and one
  // whose scene cannot be read now is kept by what it recorded.
  const recentlyDeleted = db
    .select({ id: canvases.id })
    .from(canvases)
    .where(gt(canvases.deletedAt, graceStart))
    .all()
    .map((row) => row.id)
  const keptIds = [...unreadable, ...recentlyDeleted]
  if (keptIds.length > 0) {
    for (const row of db
      .select({ hash: canvasAssets.contentHash })
      .from(canvasAssets)
      .where(inArray(canvasAssets.canvasId, keptIds))
      .all()) {
      contentHashes.add(row.hash)
    }
  }

  if (contentHashes.size > 0) {
    for (const row of db
      .select({ id: canvasAssets.attachmentId })
      .from(canvasAssets)
      .where(inArray(canvasAssets.contentHash, [...contentHashes]))
      .all()) {
      attachmentIds.add(row.id)
    }
  }

  return { contentHashes, attachmentIds }
}

/** Free one canvas's assets. Returns false when the server could not be reached. */
async function releaseCanvas(
  deps: AssetReleaseDeps,
  canvasId: string,
  kept: References
): Promise<boolean> {
  const { db } = deps
  const canvas = db
    .select({ deletedAt: canvases.deletedAt })
    .from(canvases)
    .where(eq(canvases.id, canvasId))
    .get()
  // A concurrent edit on a peer revived it (delete loses to edit): it is live
  // again and keeps its assets.
  if (canvas && canvas.deletedAt === null) return true

  const rows = db.select().from(canvasAssets).where(eq(canvasAssets.canvasId, canvasId)).all()
  const freed = rows.filter(
    (row) => !kept.contentHashes.has(row.contentHash) && !kept.attachmentIds.has(row.attachmentId)
  )
  const chunkHashes = freed.flatMap((row) => row.chunkHashes)
  if (chunkHashes.length > 0 && !(await deps.dereference(chunkHashes)).ok) return false

  db.delete(canvasAssets).where(eq(canvasAssets.canvasId, canvasId)).run()
  for (const row of freed) {
    // The file is shared by content; another canvas's row keeps it on disk.
    const shared = db
      .select({ id: canvasAssets.canvasId })
      .from(canvasAssets)
      .where(eq(canvasAssets.contentHash, row.contentHash))
      .get()
    if (shared) continue
    const diskPath = canvasAssetDiskPath(deps.vaultPath, row.filename)
    try {
      deps.markWritebackIgnored(diskPath)
      await rm(diskPath, { force: true })
    } catch (err) {
      log.warn('Could not remove a freed canvas asset file', { canvasId, err })
    }
  }
  return true
}

/**
 * Free one note's attachments on the server. The files in the vault stay: they
 * are the user's files, and a note restored after the grace period uploads
 * them again under its new id.
 */
async function releaseNote(
  deps: AssetReleaseDeps,
  noteId: string,
  attachmentIds: string[],
  kept: References
): Promise<boolean> {
  const live = deps.db
    .select({ id: noteMetadata.id })
    .from(noteMetadata)
    .where(eq(noteMetadata.id, noteId))
    .get()
  if (live) return true

  const chunkHashes: string[] = []
  for (const id of attachmentIds) {
    if (kept.attachmentIds.has(id)) continue
    chunkHashes.push(...(await deps.chunkHashesOf(id)))
  }
  if (chunkHashes.length === 0) return true
  return (await deps.dereference(chunkHashes)).ok
}

/**
 * Free every recorded delete whose grace period has passed. Returns how many
 * records were settled. A record that fails stays for the next pass.
 */
export async function releaseExpiredDeletedAssets(deps: AssetReleaseDeps): Promise<number> {
  const { db } = deps
  const graceStart = deps.now() - ASSET_RELEASE_GRACE_MS
  const due = db
    .select()
    .from(deletedAssetReleases)
    .where(lte(deletedAssetReleases.deletedAt, graceStart))
    .all()
  if (due.length === 0) return 0

  const kept = stillReferenced(db, deps.vaultPath, graceStart)
  let settled = 0
  for (const release of due) {
    try {
      const done =
        release.itemType === 'canvas'
          ? await releaseCanvas(deps, release.itemId, kept)
          : await releaseNote(deps, release.itemId, release.attachmentIds ?? [], kept)
      if (!done) {
        log.warn("Could not free a deleted item's assets; retrying later", {
          itemType: release.itemType
        })
        continue
      }
      db.delete(deletedAssetReleases)
        .where(
          and(
            eq(deletedAssetReleases.itemType, release.itemType),
            eq(deletedAssetReleases.itemId, release.itemId)
          )
        )
        .run()
      settled++
    } catch (err) {
      log.warn("Freeing a deleted item's assets failed; retrying later", {
        itemType: release.itemType,
        err
      })
    }
  }
  return settled
}
