import { z } from 'zod'

/**
 * "Recently opened" trail. Device-local by design — see the note on the
 * `recently_opened` table. Not a sync item type.
 */

/**
 * Notes and canvases; the field exists so journal/file can join later.
 *
 * Widening only — 'note' stays valid, so rows written by older builds still
 * parse and still resolve.
 */
export const RECENTLY_OPENED_ITEM_TYPES = ['note', 'canvas'] as const
export const RecentlyOpenedItemTypeSchema = z.enum(RECENTLY_OPENED_ITEM_TYPES)
export type RecentlyOpenedItemType = z.infer<typeof RecentlyOpenedItemTypeSchema>

export const RecordRecentlyOpenedSchema = z.object({
  itemId: z.string().min(1),
  itemType: RecentlyOpenedItemTypeSchema
})
export type RecordRecentlyOpenedInput = z.infer<typeof RecordRecentlyOpenedSchema>

export const ListRecentlyOpenedSchema = z.object({
  limit: z.number().int().min(1).max(50).optional()
})
export type ListRecentlyOpenedInput = z.infer<typeof ListRecentlyOpenedSchema>

/**
 * Title/emoji/path are resolved at read time — from the note cache for notes
 * and from the canvases table for canvases — so a row whose item no longer
 * exists is dropped rather than returned stale.
 */
export interface RecentlyOpenedItem {
  itemId: string
  itemType: RecentlyOpenedItemType
  openedAt: string
  title: string
  path: string
  /**
   * Icon value for the row: a bare emoji, or an `icon:`/`custom:` reference.
   * Carries the canvas `icon` column for canvas rows.
   */
  emoji: string | null
  /** Note file type ('markdown', 'pdf', …), or 'canvas' for a canvas row. */
  fileType: string
}

/** Rows kept per device. Older entries are pruned on write. */
export const RECENTLY_OPENED_LIMIT = 50
