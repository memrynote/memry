/**
 * Bookmark query functions for Drizzle ORM.
 * These queries operate on data.db (source of truth for bookmarks).
 *
 * @module db/queries/bookmarks
 */

import { eq, and, desc, asc, sql, count } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { bookmarks, type Bookmark, type NewBookmark } from '@memry/db-schema/schema/bookmarks'
import * as schema from '@memry/db-schema/schema'

type DrizzleDb = BetterSQLite3Database<typeof schema>

// ============================================================================
// Bookmark CRUD
// ============================================================================

/**
 * Insert a new bookmark.
 */
export function insertBookmark(db: DrizzleDb, bookmark: NewBookmark): Bookmark {
  return db.insert(bookmarks).values(bookmark).returning().get()
}

/**
 * Delete a bookmark by ID.
 */
export function deleteBookmark(db: DrizzleDb, id: string): boolean {
  const result = db.delete(bookmarks).where(eq(bookmarks.id, id)).run()
  return result.changes > 0
}

/**
 * Delete a bookmark by item type and ID.
 */
export function deleteBookmarkByItem(db: DrizzleDb, itemType: string, itemId: string): boolean {
  const result = db
    .delete(bookmarks)
    .where(and(eq(bookmarks.itemType, itemType), eq(bookmarks.itemId, itemId)))
    .run()
  return result.changes > 0
}

/**
 * Get a bookmark by ID.
 */
export function getBookmarkById(db: DrizzleDb, id: string): Bookmark | undefined {
  return db.select().from(bookmarks).where(eq(bookmarks.id, id)).get()
}

/**
 * Get a bookmark by item type and ID.
 */
export function getBookmarkByItem(
  db: DrizzleDb,
  itemType: string,
  itemId: string
): Bookmark | undefined {
  return db
    .select()
    .from(bookmarks)
    .where(and(eq(bookmarks.itemType, itemType), eq(bookmarks.itemId, itemId)))
    .get()
}

/**
 * Check if an item is bookmarked.
 */
export function isBookmarked(db: DrizzleDb, itemType: string, itemId: string): boolean {
  const result = db
    .select({ id: bookmarks.id })
    .from(bookmarks)
    .where(and(eq(bookmarks.itemType, itemType), eq(bookmarks.itemId, itemId)))
    .get()
  return result !== undefined
}

/**
 * Check if a bookmark exists by ID.
 */
export function bookmarkExists(db: DrizzleDb, id: string): boolean {
  const result = db.select({ id: bookmarks.id }).from(bookmarks).where(eq(bookmarks.id, id)).get()
  return result !== undefined
}

// ============================================================================
// Bookmark Listing
// ============================================================================

export interface ListBookmarksOptions {
  /** Filter by item type */
  itemType?: string
  /** Sort field */
  sortBy?: 'position' | 'createdAt'
  /** Sort order */
  sortOrder?: 'asc' | 'desc'
  /** Maximum number of results */
  limit?: number
  /** Offset for pagination */
  offset?: number
}

/**
 * List bookmarks with optional filters.
 */
export function listBookmarks(db: DrizzleDb, options: ListBookmarksOptions = {}): Bookmark[] {
  const { itemType, sortBy = 'position', sortOrder = 'asc', limit = 100, offset = 0 } = options

  const orderFn = sortOrder === 'asc' ? asc : desc
  const sortColumn = sortBy === 'position' ? bookmarks.position : bookmarks.createdAt

  let query = db.select().from(bookmarks)

  if (itemType) {
    query = query.where(eq(bookmarks.itemType, itemType)) as typeof query
  }

  return query.orderBy(orderFn(sortColumn)).limit(limit).offset(offset).all()
}

/**
 * Count bookmarks with optional filter.
 */
export function countBookmarks(db: DrizzleDb, itemType?: string): number {
  let query = db.select({ count: count() }).from(bookmarks)

  if (itemType) {
    query = query.where(eq(bookmarks.itemType, itemType)) as typeof query
  }

  const result = query.get()
  return result?.count ?? 0
}

/**
 * List bookmarks by item type.
 */
export function listBookmarksByType(db: DrizzleDb, itemType: string): Bookmark[] {
  return db
    .select()
    .from(bookmarks)
    .where(eq(bookmarks.itemType, itemType))
    .orderBy(asc(bookmarks.position))
    .all()
}

/**
 * Get all unique item types with counts.
 */
export function getBookmarkTypeCounts(db: DrizzleDb): { itemType: string; count: number }[] {
  return db
    .select({
      itemType: bookmarks.itemType,
      count: count()
    })
    .from(bookmarks)
    .groupBy(bookmarks.itemType)
    .orderBy(desc(count()))
    .all()
}

// ============================================================================
// Bookmark Ordering
// ============================================================================

/**
 * Get the next available position for a new bookmark.
 */
export function getNextBookmarkPosition(db: DrizzleDb): number {
  const result = db
    .select({ maxPosition: sql<number>`max(${bookmarks.position})` })
    .from(bookmarks)
    .get()

  return (result?.maxPosition ?? -1) + 1
}

/**
 * Update bookmark position.
 */
export function updateBookmarkPosition(db: DrizzleDb, id: string, position: number): boolean {
  const result = db.update(bookmarks).set({ position }).where(eq(bookmarks.id, id)).run()
  return result.changes > 0
}

/**
 * Reorder bookmarks by updating their positions.
 */
export function reorderBookmarks(db: DrizzleDb, bookmarkIds: string[]): void {
  for (let i = 0; i < bookmarkIds.length; i++) {
    db.update(bookmarks).set({ position: i }).where(eq(bookmarks.id, bookmarkIds[i])).run()
  }
}

// ============================================================================
// Bulk Operations
// ============================================================================

/**
 * Bulk create bookmarks.
 * Returns the number of successfully created bookmarks (duplicates are skipped).
 */
export function bulkCreateBookmarks(
  db: DrizzleDb,
  items: Array<{ itemType: string; itemId: string }>,
  generateId: () => string
): number {
  let created = 0
  const startPosition = getNextBookmarkPosition(db)

  for (let i = 0; i < items.length; i++) {
    const { itemType, itemId } = items[i]

    // Skip if already bookmarked
    if (isBookmarked(db, itemType, itemId)) {
      continue
    }

    try {
      db.insert(bookmarks)
        .values({
          id: generateId(),
          itemType,
          itemId,
          position: startPosition + created
        })
        .run()
      created++
    } catch {
      // Skip on unique constraint violation (shouldn't happen due to check above)
    }
  }

  return created
}

/**
 * Bulk delete bookmarks by IDs.
 */
export function bulkDeleteBookmarks(db: DrizzleDb, ids: string[]): number {
  if (ids.length === 0) return 0

  const result = db
    .delete(bookmarks)
    .where(sql`${bookmarks.id} IN ${ids}`)
    .run()

  return result.changes
}

/**
 * Delete all bookmarks for a specific item type.
 */
export function deleteBookmarksByType(db: DrizzleDb, itemType: string): number {
  const result = db.delete(bookmarks).where(eq(bookmarks.itemType, itemType)).run()
  return result.changes
}

/**
 * Delete bookmarks for items that no longer exist.
 * This is called during cleanup when source items are deleted.
 *
 * @param db - Database instance
 * @param itemType - Type of items to check
 * @param existingIds - Set of IDs that still exist
 * @returns Number of orphaned bookmarks deleted
 */
export function deleteOrphanedBookmarks(
  db: DrizzleDb,
  itemType: string,
  existingIds: Set<string>
): number {
  const typeBookmarks = listBookmarksByType(db, itemType)
  const orphanedIds = typeBookmarks.filter((b) => !existingIds.has(b.itemId)).map((b) => b.id)

  if (orphanedIds.length === 0) return 0

  return bulkDeleteBookmarks(db, orphanedIds)
}

// ============================================================================
// Toggle Operation
// ============================================================================

/**
 * Toggle bookmark status for an item.
 * Creates a bookmark if it doesn't exist, deletes it if it does.
 *
 * @returns Object with isBookmarked status and the bookmark if created
 */
export function toggleBookmark(
  db: DrizzleDb,
  itemType: string,
  itemId: string,
  generateId: () => string
): { isBookmarked: boolean; bookmark: Bookmark | null } {
  const existing = getBookmarkByItem(db, itemType, itemId)

  if (existing) {
    // Delete existing bookmark
    deleteBookmark(db, existing.id)
    return { isBookmarked: false, bookmark: null }
  } else {
    // Create new bookmark
    const position = getNextBookmarkPosition(db)
    const bookmark = insertBookmark(db, {
      id: generateId(),
      itemType,
      itemId,
      position
    })
    return { isBookmarked: true, bookmark }
  }
}
