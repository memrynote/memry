/**
 * Stored assets of items this device deleted, waiting out the grace period
 * before their server chunks are freed (#3015).
 *
 * One row per (item type, item id), written when this device raises the
 * delete. A delete that arrives from a peer writes nothing here: the device
 * that deleted the item frees its assets, so the work runs once per delete.
 * `attachmentIds` captures a note's attachment references at delete time,
 * because the note's metadata row is removed with the note. A canvas keeps its
 * `canvas_assets` rows after its soft delete, so its column stays null.
 *
 * @module db/schema/deleted-asset-releases
 */

import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core'

export const deletedAssetReleases = sqliteTable(
  'deleted_asset_releases',
  {
    itemType: text('item_type').$type<'note' | 'canvas'>().notNull(),
    itemId: text('item_id').notNull(),
    /** Epoch ms of the delete; the grace period runs from here. */
    deletedAt: integer('deleted_at').notNull(),
    attachmentIds: text('attachment_ids', { mode: 'json' }).$type<string[] | null>()
  },
  (table) => [primaryKey({ columns: [table.itemType, table.itemId] })]
)

export type DeletedAssetReleaseRow = typeof deletedAssetReleases.$inferSelect
