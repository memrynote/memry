import { bookmarkSyncId, type BookmarkItemType } from '@memry/contracts/bookmark-types'

import type { VaultDb } from '@/db/index'
import { withVaultTransaction } from '@/db/tx'
import { createLogger } from '@/lib/logger'
import type { NoteOpsContext } from '@/features/notes/note-ops'
import { bumpClock } from '@/sync/outbox'

const log = createLogger('Bookmarks')

/**
 * Bookmarks (boards 26B / 26C, `Add to bookmarks`).
 *
 * The id is DERIVED from the pair, never minted: `bookmarkSyncId` is the same
 * function desktop and migration 0043 use, so two devices bookmarking the same
 * note offline produce the identical row and last-write-wins merges them
 * instead of colliding on the `(item_type, item_id)` unique index.
 *
 * A "remove" is a tombstone, not a row deletion — same rule as a note: hard
 * deleting locally would make the next pull treat the server's copy as new and
 * the bookmark would come back.
 */

export type BookmarkKey = `${BookmarkItemType}:${string}`

export function bookmarkKey(itemType: BookmarkItemType, itemId: string): BookmarkKey {
  return `${itemType}:${itemId}`
}

interface BookmarkPayload {
  itemType?: string
  itemId?: string
  position?: number
  clock?: Record<string, number>
  createdAt?: string
  [unknownFieldsFromNewerClients: string]: unknown
}

/**
 * Every live bookmark on the device, as `type:id` keys.
 *
 * A Set rather than a list: the only question the tree asks is "is this row
 * bookmarked", once per row per render.
 */
export async function readBookmarkKeys(db: VaultDb): Promise<Set<BookmarkKey>> {
  const rows = await db.getAllAsync<{ payload: string | null }>(
    `SELECT payload FROM sync_items WHERE type = 'bookmark' AND deleted_at IS NULL`
  )
  const keys = new Set<BookmarkKey>()
  for (const row of rows) {
    if (!row.payload) continue
    try {
      const payload = JSON.parse(row.payload) as BookmarkPayload
      if (typeof payload.itemType === 'string' && typeof payload.itemId === 'string') {
        keys.add(bookmarkKey(payload.itemType as BookmarkItemType, payload.itemId))
      }
    } catch {
      log.warn('Bookmark payload is not JSON; skipping')
    }
  }
  return keys
}

async function readStoredBookmark(db: VaultDb, id: string): Promise<BookmarkPayload | null> {
  const row = await db.getFirstAsync<{ payload: string | null }>(
    'SELECT payload FROM sync_items WHERE id = ?',
    [id]
  )
  if (!row?.payload) return null
  try {
    return JSON.parse(row.payload) as BookmarkPayload
  } catch {
    return null
  }
}

export async function addBookmark(
  ctx: NoteOpsContext,
  itemType: BookmarkItemType,
  itemId: string
): Promise<void> {
  const id = bookmarkSyncId(itemType, itemId)
  const now = Date.now()
  // The row may already exist as a tombstone from an earlier removal on this
  // device. Its payload — and its clock — are reused so the re-add is NEWER
  // than the delete it undoes; a fresh `{thisDevice: 1}` clock would read as
  // older on every peer and the bookmark would never come back.
  const payload: BookmarkPayload = (await readStoredBookmark(ctx.db, id)) ?? {
    createdAt: new Date(now).toISOString()
  }
  payload.itemType = itemType
  payload.itemId = itemId
  payload.position = payload.position ?? 0
  bumpClock(payload as Record<string, unknown>, ctx.deviceId)
  const serialized = JSON.stringify(payload)

  await withVaultTransaction(ctx.db, async () => {
    await ctx.db.runAsync(
      `INSERT INTO sync_items (id, type, vault_id, updated_at, deleted_at, payload_state, payload)
       VALUES (?, 'bookmark', ?, ?, NULL, 'full', ?)
       ON CONFLICT(id) DO UPDATE SET
         updated_at = excluded.updated_at,
         deleted_at = NULL,
         payload_state = 'full',
         payload = excluded.payload`,
      [id, ctx.vaultId, now, serialized]
    )
    await ctx.outbox.enqueueRecord('bookmark', id, 'update', serialized)
  })
}

export async function removeBookmark(
  ctx: NoteOpsContext,
  itemType: BookmarkItemType,
  itemId: string
): Promise<void> {
  const id = bookmarkSyncId(itemType, itemId)
  const stored = await readStoredBookmark(ctx.db, id)
  if (!stored) return
  const now = Date.now()
  bumpClock(stored as Record<string, unknown>, ctx.deviceId)
  const serialized = JSON.stringify(stored)

  await withVaultTransaction(ctx.db, async () => {
    await ctx.db.runAsync(
      'UPDATE sync_items SET deleted_at = ?, updated_at = ?, payload = ? WHERE id = ?',
      [now, now, serialized, id]
    )
    await ctx.outbox.enqueueRecord('bookmark', id, 'delete', serialized)
  })
}

export async function toggleBookmark(
  ctx: NoteOpsContext,
  itemType: BookmarkItemType,
  itemId: string,
  bookmarked: boolean
): Promise<void> {
  if (bookmarked) await removeBookmark(ctx, itemType, itemId)
  else await addBookmark(ctx, itemType, itemId)
}

/**
 * Re-point every bookmark that names a folder path under `fromPath`.
 *
 * A folder bookmark's `itemId` IS the path, so a rename or a move orphans it
 * unless the rows travel with the folder. The bookmark id is derived from the
 * path too, so this is a delete of the old row and an add of the new one, not
 * an update.
 */
export async function rewriteFolderBookmarks(
  ctx: NoteOpsContext,
  fromPath: string,
  toPath: string
): Promise<void> {
  const keys = await readBookmarkKeys(ctx.db)
  for (const key of keys) {
    if (!key.startsWith('folder:')) continue
    const path = key.slice('folder:'.length)
    if (path !== fromPath && !path.startsWith(`${fromPath}/`)) continue
    await removeBookmark(ctx, 'folder', path)
    await addBookmark(ctx, 'folder', toPath + path.slice(fromPath.length))
  }
}

/** Drop the bookmarks a deleted folder and its descendants left behind. */
export async function dropFolderBookmarks(ctx: NoteOpsContext, path: string): Promise<void> {
  const keys = await readBookmarkKeys(ctx.db)
  for (const key of keys) {
    if (!key.startsWith('folder:')) continue
    const bookmarked = key.slice('folder:'.length)
    if (bookmarked === path || bookmarked.startsWith(`${path}/`)) {
      await removeBookmark(ctx, 'folder', bookmarked)
    }
  }
}
