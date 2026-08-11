import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type { VectorClock } from '@memry/contracts/sync-api'

/**
 * Canvas folders — real directories under `<vault>/canvases`.
 *
 * Placement lives on the canvas row, so this table carries only a folder's
 * icon and its existence. That existence is what lets an EMPTY folder reach
 * another device; drop either need and this table goes with them.
 *
 * `id` is derived from `path` (canvasFolderSyncId), so two devices creating the
 * same folder offline converge on one row instead of colliding on the unique
 * index at pull time.
 *
 * Timestamps are INTEGER epoch ms, matching `canvases` — NOT the ISO strings
 * `savedFilters` uses.
 */
export const canvasFolders = sqliteTable(
  'canvas_folders',
  {
    id: text('id').primaryKey(),
    vaultId: text('vault_id').notNull(),
    /** Forward-slashed, relative to `canvases/`. Never empty. */
    path: text('path').notNull(),
    icon: text('icon'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    /** Soft delete: tombstones must stay visible to sync. */
    deletedAt: integer('deleted_at'),
    clock: text('clock', { mode: 'json' }).$type<VectorClock>(),
    syncedAt: integer('synced_at')
  },
  (table) => [uniqueIndex('canvas_folders_vault_path_idx').on(table.vaultId, table.path)]
)

export type CanvasFolderRow = typeof canvasFolders.$inferSelect
export type NewCanvasFolderRow = typeof canvasFolders.$inferInsert
