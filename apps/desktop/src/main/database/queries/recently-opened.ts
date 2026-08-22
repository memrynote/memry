import { and, desc, inArray, isNull, notInArray } from 'drizzle-orm'
import { recentlyOpened } from '@memry/db-schema/schema/recently-opened'
import { canvases } from '@memry/db-schema/schema/canvas'
import { noteCache } from '@memry/db-schema/schema/notes-cache'
import {
  RECENTLY_OPENED_LIMIT,
  type RecentlyOpenedItem,
  type RecentlyOpenedItemType
} from '@memry/contracts/recents-api'
import type { DataDb, IndexDb } from '../types'

/**
 * Upsert the trail entry for an item and prune the tail.
 *
 * One row per item, not one per open: opening the same note fifty times is
 * still a single row with a bumped timestamp.
 */
export function recordRecentlyOpened(
  db: DataDb,
  input: { id: string; itemId: string; itemType: RecentlyOpenedItemType; openedAt: string }
): void {
  db.insert(recentlyOpened)
    .values({
      id: input.id,
      itemId: input.itemId,
      itemType: input.itemType,
      openedAt: input.openedAt
    })
    .onConflictDoUpdate({
      target: [recentlyOpened.itemType, recentlyOpened.itemId],
      set: { openedAt: input.openedAt }
    })
    .run()

  const keep = db
    .select({ id: recentlyOpened.id })
    .from(recentlyOpened)
    .orderBy(desc(recentlyOpened.openedAt))
    .limit(RECENTLY_OPENED_LIMIT)
    .all()

  if (keep.length === RECENTLY_OPENED_LIMIT) {
    db.delete(recentlyOpened)
      .where(
        notInArray(
          recentlyOpened.id,
          keep.map((k) => k.id)
        )
      )
      .run()
  }
}

/**
 * Vault-relative display path for a canvas row.
 *
 * The file is the source of truth, so its path is what the widget shows. A
 * legacy row whose ciphertext could never be migrated has no file path; fall
 * back to where the canvas would live so the row still reads as a canvas.
 */
function canvasPath(row: {
  filePath: string | null
  folder: string | null
  title: string
}): string {
  if (row.filePath) return row.filePath
  return ['canvases', row.folder, row.title].filter(Boolean).join('/')
}

/**
 * Newest-first trail, resolved per item type at read time.
 *
 * Notes resolve against the note cache (index DB) and canvases against the
 * canvases table (data DB), so this cannot be one SQL join. Rows whose item is
 * gone — deleted note, trashed canvas — are dropped rather than returned under
 * a stale title, which is also why the trail stores no title.
 */
export function listRecentlyOpened(
  db: DataDb,
  indexDb: IndexDb,
  limit: number
): RecentlyOpenedItem[] {
  const rows = db
    .select()
    .from(recentlyOpened)
    .orderBy(desc(recentlyOpened.openedAt))
    .limit(RECENTLY_OPENED_LIMIT)
    .all()

  if (rows.length === 0) return []

  const noteIds = rows.filter((r) => r.itemType === 'note').map((r) => r.itemId)
  const canvasIds = rows.filter((r) => r.itemType === 'canvas').map((r) => r.itemId)

  const notesById = new Map(
    (noteIds.length === 0
      ? []
      : indexDb
          .select({
            id: noteCache.id,
            title: noteCache.title,
            path: noteCache.path,
            emoji: noteCache.emoji,
            fileType: noteCache.fileType
          })
          .from(noteCache)
          .where(inArray(noteCache.id, noteIds))
          .all()
    ).map((n) => [n.id, n] as const)
  )

  const canvasesById = new Map(
    (canvasIds.length === 0
      ? []
      : db
          .select({
            id: canvases.id,
            title: canvases.title,
            filePath: canvases.filePath,
            folder: canvases.folder,
            icon: canvases.icon
          })
          .from(canvases)
          // Tombstoned canvases stay in the table for sync; they are gone as
          // far as the user is concerned, so they must not surface here.
          .where(and(inArray(canvases.id, canvasIds), isNull(canvases.deletedAt)))
          .all()
    ).map((c) => [c.id, c] as const)
  )

  const items: RecentlyOpenedItem[] = []
  for (const row of rows) {
    const itemType = row.itemType as RecentlyOpenedItemType
    if (itemType === 'canvas') {
      const canvas = canvasesById.get(row.itemId)
      if (!canvas) continue
      const title = canvas.title ?? ''
      items.push({
        itemId: row.itemId,
        itemType,
        openedAt: row.openedAt,
        title,
        path: canvasPath({ filePath: canvas.filePath, folder: canvas.folder, title }),
        emoji: canvas.icon ?? null,
        fileType: 'canvas'
      })
    } else {
      const note = notesById.get(row.itemId)
      if (!note) continue
      items.push({
        itemId: row.itemId,
        itemType,
        openedAt: row.openedAt,
        title: note.title,
        path: note.path,
        emoji: note.emoji ?? null,
        fileType: note.fileType ?? 'markdown'
      })
    }
    if (items.length >= limit) break
  }
  return items
}
