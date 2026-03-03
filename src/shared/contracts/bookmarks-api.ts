/**
 * Bookmarks IPC API Contract
 *
 * A simple, flat bookmarking system that works with any item type.
 * Uses polymorphic pattern (item_type + item_id) for extensibility.
 *
 * @module contracts/bookmarks-api
 */

import { z } from 'zod'

// Import and re-export channels from shared (single source of truth)
import { BookmarksChannels } from '../ipc-channels'
export { BookmarksChannels }

// Re-export types from schema
import { BookmarkItemTypes, type BookmarkItemType } from '../db/schema/bookmarks'
export { BookmarkItemTypes, type BookmarkItemType }

// ============================================================================
// Types
// ============================================================================

/**
 * Full bookmark record as stored in the database.
 * Note: itemType is string to allow for extensibility - new item types
 * can be added without schema changes. Use BookmarkItemTypes constants
 * for known types.
 */
export interface Bookmark {
  id: string
  itemType: string
  itemId: string
  position: number
  createdAt: string
}

/**
 * Bookmark with resolved item details for display.
 * The item field varies based on itemType.
 */
export interface BookmarkWithItem extends Bookmark {
  /** Title of the bookmarked item (resolved from the source) */
  itemTitle: string | null
  /** Whether the source item still exists */
  itemExists: boolean
  /** Additional item-specific metadata (varies by item type) */
  itemMeta?: BookmarkItemMeta
}

/**
 * Optional metadata resolved from the source item
 */
export interface BookmarkItemMeta {
  /** Path for notes/files */
  path?: string
  /** Emoji icon for notes */
  emoji?: string
  /** Tags for notes/tasks */
  tags?: string[]
}

// ============================================================================
// Request Schemas
// ============================================================================

/**
 * Schema for creating a new bookmark
 */
export const BookmarkCreateSchema = z.object({
  itemType: z.string(), // Validated against BookmarkItemTypes at runtime
  itemId: z.string().min(1)
})

/**
 * Schema for checking if an item is bookmarked
 */
export const BookmarkCheckSchema = z.object({
  itemType: z.string(),
  itemId: z.string().min(1)
})

/**
 * Schema for toggling a bookmark (create if not exists, delete if exists)
 */
export const BookmarkToggleSchema = z.object({
  itemType: z.string(),
  itemId: z.string().min(1)
})

/**
 * Schema for reordering bookmarks
 */
export const BookmarkReorderSchema = z.object({
  /** Ordered array of bookmark IDs */
  bookmarkIds: z.array(z.string().min(1))
})

/**
 * Schema for listing bookmarks with optional filters
 */
export const BookmarkListSchema = z.object({
  /** Filter by item type */
  itemType: z.string().optional(),
  /** Sort field */
  sortBy: z.enum(['position', 'createdAt']).default('position'),
  /** Sort order */
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
  /** Maximum number of results */
  limit: z.number().int().min(1).max(1000).default(100),
  /** Offset for pagination */
  offset: z.number().int().min(0).default(0)
})

/**
 * Schema for bulk operations
 */
export const BookmarkBulkDeleteSchema = z.object({
  bookmarkIds: z.array(z.string().min(1)).min(1)
})

export const BookmarkBulkCreateSchema = z.object({
  items: z.array(
    z.object({
      itemType: z.string(),
      itemId: z.string().min(1)
    })
  )
})

// ============================================================================
// Response Types
// ============================================================================

export interface BookmarkCreateResponse {
  success: boolean
  bookmark: Bookmark | null
  error?: string
}

export interface BookmarkToggleResponse {
  success: boolean
  /** Whether the item is now bookmarked */
  isBookmarked: boolean
  /** The bookmark if it was created, null if deleted */
  bookmark: Bookmark | null
  error?: string
}

export interface BookmarkListResponse {
  bookmarks: BookmarkWithItem[]
  total: number
  hasMore: boolean
}

export interface BookmarkDeleteResponse {
  success: boolean
  error?: string
}

// ============================================================================
// Handler Signatures
// ============================================================================

export interface BookmarksHandlers {
  [BookmarksChannels.invoke.CREATE]: (
    input: z.infer<typeof BookmarkCreateSchema>
  ) => Promise<BookmarkCreateResponse>

  [BookmarksChannels.invoke.DELETE]: (id: string) => Promise<BookmarkDeleteResponse>

  [BookmarksChannels.invoke.GET]: (id: string) => Promise<Bookmark | null>

  [BookmarksChannels.invoke.LIST]: (
    input?: z.infer<typeof BookmarkListSchema>
  ) => Promise<BookmarkListResponse>

  [BookmarksChannels.invoke.IS_BOOKMARKED]: (
    input: z.infer<typeof BookmarkCheckSchema>
  ) => Promise<boolean>

  [BookmarksChannels.invoke.TOGGLE]: (
    input: z.infer<typeof BookmarkToggleSchema>
  ) => Promise<BookmarkToggleResponse>

  [BookmarksChannels.invoke.REORDER]: (
    input: z.infer<typeof BookmarkReorderSchema>
  ) => Promise<{ success: boolean; error?: string }>

  [BookmarksChannels.invoke.LIST_BY_TYPE]: (itemType: string) => Promise<BookmarkListResponse>

  [BookmarksChannels.invoke.GET_BY_ITEM]: (
    input: z.infer<typeof BookmarkCheckSchema>
  ) => Promise<Bookmark | null>

  [BookmarksChannels.invoke.BULK_DELETE]: (
    input: z.infer<typeof BookmarkBulkDeleteSchema>
  ) => Promise<{ success: boolean; deletedCount: number; error?: string }>

  [BookmarksChannels.invoke.BULK_CREATE]: (
    input: z.infer<typeof BookmarkBulkCreateSchema>
  ) => Promise<{ success: boolean; createdCount: number; error?: string }>
}

// ============================================================================
// Event Payloads
// ============================================================================

export interface BookmarkCreatedEvent {
  bookmark: Bookmark
}

export interface BookmarkDeletedEvent {
  id: string
  itemType: string
  itemId: string
}

export interface BookmarksReorderedEvent {
  bookmarkIds: string[]
}

// ============================================================================
// Client API
// ============================================================================

/**
 * Bookmarks service client interface for renderer process
 *
 * @example
 * ```typescript
 * const bookmarks = window.api.bookmarks;
 *
 * // Toggle bookmark on a note
 * const result = await bookmarks.toggle({
 *   itemType: 'note',
 *   itemId: 'abc123'
 * });
 * console.log(result.isBookmarked); // true or false
 *
 * // List all bookmarks
 * const { bookmarks: list } = await bookmarks.list();
 *
 * // Check if item is bookmarked
 * const isBookmarked = await bookmarks.isBookmarked({
 *   itemType: 'note',
 *   itemId: 'abc123'
 * });
 *
 * // Listen for bookmark changes
 * window.api.on('bookmarks:created', (event) => {
 *   console.log('New bookmark:', event.bookmark);
 * });
 * ```
 */
export interface BookmarksClientAPI {
  /** Create a new bookmark */
  create(input: z.infer<typeof BookmarkCreateSchema>): Promise<BookmarkCreateResponse>

  /** Delete a bookmark by ID */
  delete(id: string): Promise<BookmarkDeleteResponse>

  /** Get a bookmark by ID */
  get(id: string): Promise<Bookmark | null>

  /** List bookmarks with optional filters */
  list(options?: z.infer<typeof BookmarkListSchema>): Promise<BookmarkListResponse>

  /** Check if an item is bookmarked */
  isBookmarked(input: z.infer<typeof BookmarkCheckSchema>): Promise<boolean>

  /** Toggle bookmark status (create or delete) */
  toggle(input: z.infer<typeof BookmarkToggleSchema>): Promise<BookmarkToggleResponse>

  /** Reorder bookmarks */
  reorder(bookmarkIds: string[]): Promise<{ success: boolean; error?: string }>

  /** List bookmarks filtered by item type */
  listByType(itemType: string): Promise<BookmarkListResponse>

  /** Get bookmark for a specific item */
  getByItem(input: z.infer<typeof BookmarkCheckSchema>): Promise<Bookmark | null>

  /** Delete multiple bookmarks */
  bulkDelete(
    bookmarkIds: string[]
  ): Promise<{ success: boolean; deletedCount: number; error?: string }>

  /** Create multiple bookmarks */
  bulkCreate(
    items: Array<{ itemType: string; itemId: string }>
  ): Promise<{ success: boolean; createdCount: number; error?: string }>
}
