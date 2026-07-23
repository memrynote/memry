import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import type { VectorClock } from '@memry/contracts/sync-api'

export const canvases = sqliteTable(
  'canvases',
  {
    id: text('id').primaryKey(),
    vaultId: text('vault_id').notNull(),
    // Plaintext title (matches the notes cache / home_pages precedent); the
    // scene itself is always encrypted at rest in snapshotCiphertext.
    title: text('title'),
    // Vault-key-encrypted Excalidraw scene JSON (serializeAsJSON output).
    snapshotCiphertext: text('snapshot_ciphertext').notNull(),
    vectorClock: text('vector_clock', { mode: 'json' }).$type<VectorClock>().notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    // Soft-delete tombstone: deletes must stay visible to sync (see the
    // spatial-canvas spec §5.4); never hard-delete a synced canvas row.
    deletedAt: integer('deleted_at'),
    lastSyncedAt: integer('last_synced_at'),
    // Sync clock; null until the canvas sync type ships and seeds it.
    clock: text('clock', { mode: 'json' }).$type<VectorClock>()
  },
  (table) => [
    index('canvases_by_vault').on(table.vaultId),
    index('canvases_by_updated').on(table.vaultId, table.updatedAt)
  ]
)

/**
 * Excalidraw library items (the shapes panel), one row per LibraryItem.
 *
 * Vault-global, NOT per canvas — Excalidraw's library is a single collection
 * shared by every scene, and the editor remounts per canvas id, so anything
 * scoped to a canvas would vanish on the next tab switch.
 *
 * Row-per-item (rather than one blob) so a future sync type gets per-item LWW
 * and real delete tombstones for free: two devices importing different kits
 * both keep theirs. The sync columns are present from the first migration so
 * enabling sync stays additive.
 */
export const canvasLibraryItems = sqliteTable(
  'canvas_library_items',
  {
    // The Excalidraw LibraryItem id — stable across devices, which is what
    // makes per-item reconciliation possible without a mapping table.
    id: text('id').primaryKey(),
    vaultId: text('vault_id').notNull(),
    // Vault-key-encrypted LibraryItem JSON (elements, name, status, created).
    itemCiphertext: text('item_ciphertext').notNull(),
    vectorClock: text('vector_clock', { mode: 'json' }).$type<VectorClock>().notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    // Soft-delete: removing an item from the panel must stay visible to sync,
    // otherwise the item resurrects from another device on the next pull.
    deletedAt: integer('deleted_at'),
    lastSyncedAt: integer('last_synced_at'),
    clock: text('clock', { mode: 'json' }).$type<VectorClock>()
  },
  (table) => [index('canvas_library_items_by_vault').on(table.vaultId, table.updatedAt)]
)

export type CanvasLibraryItemRow = typeof canvasLibraryItems.$inferSelect
export type NewCanvasLibraryItemRow = typeof canvasLibraryItems.$inferInsert

/**
 * Advisory index of which entities a canvas references. NOT authoritative —
 * the geometry/refs source of truth is the encrypted scene snapshot. Rows are
 * rewritten from the scene on every save/apply; consumers must LEFT JOIN and
 * null-check because entity deletion does not cascade here.
 */
export const canvasEntityRefs = sqliteTable(
  'canvas_entity_refs',
  {
    canvasId: text('canvas_id')
      .notNull()
      .references(() => canvases.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').$type<'note' | 'task' | 'calendar_event'>().notNull(),
    entityId: text('entity_id').notNull()
  },
  (table) => [
    primaryKey({ columns: [table.canvasId, table.entityType, table.entityId] }),
    index('idx_canvas_refs_entity').on(table.entityType, table.entityId)
  ]
)

export type CanvasRow = typeof canvases.$inferSelect
export type NewCanvasRow = typeof canvases.$inferInsert
export type CanvasEntityRefRow = typeof canvasEntityRefs.$inferSelect
export type NewCanvasEntityRefRow = typeof canvasEntityRefs.$inferInsert

/**
 * Per-device dedup index + GC bookkeeping for externalized canvas image assets (M5).
 * content_hash = plaintext sha256 (dedup key, per vault); attachment_id = random id from
 * the attachment pipeline (stable per content_hash within a vault); chunk_hashes = encrypted
 * chunk hashes used for server dereference. One row per (canvas, image).
 * FK canvas_id -> canvases(id) ON DELETE cascade lives in the SQL migration (mirrors
 * canvas_entity_refs); delete is soft, so GC prunes rows explicitly — the FK is a safety net.
 */
export const canvasAssets = sqliteTable(
  'canvas_assets',
  {
    vaultId: text('vault_id').notNull(),
    canvasId: text('canvas_id')
      .notNull()
      .references(() => canvases.id, { onDelete: 'cascade' }),
    contentHash: text('content_hash').notNull(),
    attachmentId: text('attachment_id').notNull(),
    // A representative Excalidraw fileId that references this content. Assets are
    // content-addressed, so several scene elements (distinct fileIds) may share one
    // contentHash → one physical asset; this stores the first-seen fileId. Rendering,
    // restore, and GC all key on contentHash (never fileId), so the collapse is by design.
    fileId: text('file_id').notNull(),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    chunkHashes: text('chunk_hashes', { mode: 'json' }).$type<string[]>().notNull(),
    createdAt: integer('created_at').notNull()
  },
  (table) => [
    // Content-addressed dedup key: one row per (canvas, distinct content), NOT per fileId.
    primaryKey({ columns: [table.canvasId, table.contentHash] }),
    index('idx_canvas_assets_dedup').on(table.vaultId, table.contentHash),
    index('idx_canvas_assets_attachment').on(table.attachmentId)
  ]
)

export type CanvasAssetRow = typeof canvasAssets.$inferSelect
export type NewCanvasAssetRow = typeof canvasAssets.$inferInsert
