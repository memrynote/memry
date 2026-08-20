import { desc, inArray, notInArray } from 'drizzle-orm'
import { recentlyOpened } from '@memry/db-schema/schema/recently-opened'
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
 * Newest-first trail, resolved against the note cache.
 *
 * The trail lives in the data DB and the note cache in the index DB, so this
 * cannot be one SQL join. Rows whose note is gone are dropped rather than
 * returned under a stale title — which is also why the trail stores no title.
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
  if (noteIds.length === 0) return []

  const notes = indexDb
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

  const byId = new Map(notes.map((n) => [n.id, n]))

  const items: RecentlyOpenedItem[] = []
  for (const row of rows) {
    const note = byId.get(row.itemId)
    if (!note) continue
    items.push({
      itemId: row.itemId,
      itemType: row.itemType as RecentlyOpenedItemType,
      openedAt: row.openedAt,
      title: note.title,
      path: note.path,
      emoji: note.emoji ?? null,
      fileType: note.fileType ?? 'markdown'
    })
    if (items.length >= limit) break
  }
  return items
}
