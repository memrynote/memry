import { z } from 'zod'

/**
 * "Recently opened" trail. Device-local by design — see the note on the
 * `recently_opened` table. Not a sync item type.
 */

/** Only notes for now; the field exists so canvas/journal can join later. */
export const RecentlyOpenedItemTypeSchema = z.literal('note')
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
 * Title/emoji/path are resolved from the note cache at read time, so a row
 * whose note no longer exists is dropped rather than returned stale.
 */
export interface RecentlyOpenedItem {
  itemId: string
  itemType: RecentlyOpenedItemType
  openedAt: string
  title: string
  path: string
  emoji: string | null
  fileType: string
}

/** Rows kept per device. Older entries are pruned on write. */
export const RECENTLY_OPENED_LIMIT = 50
