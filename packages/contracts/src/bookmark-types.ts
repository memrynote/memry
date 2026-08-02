/**
 * Canonical bookmark item types shared across contracts and schema.
 */

export const BookmarkItemTypes = {
  NOTE: 'note',
  JOURNAL: 'journal',
  TASK: 'task',
  FOLDER: 'folder',
  TAG: 'tag',
  IMAGE: 'image',
  PDF: 'pdf',
  AUDIO: 'audio',
  VIDEO: 'video',
  CANVAS: 'canvas',
  FILE: 'file'
} as const

export type BookmarkItemType = (typeof BookmarkItemTypes)[keyof typeof BookmarkItemTypes]

/**
 * Deterministic bookmark id.
 *
 * Two devices bookmarking the same item offline would otherwise mint two
 * nanoids for one logical bookmark and collide on the
 * `(item_type, item_id)` unique index at pull time. Deriving the id from the
 * same pair makes both devices produce the identical row, so LWW merges it.
 *
 * MUST stay character-identical to the SQL in migration 0043.
 */
export function bookmarkSyncId(itemType: string, itemId: string): string {
  return `bmk_${itemType}_${itemId}`
}
