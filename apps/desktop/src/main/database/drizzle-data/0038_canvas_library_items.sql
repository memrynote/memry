-- Adds canvas_library_items: the Excalidraw library (shapes panel), one
-- encrypted row per LibraryItem, vault-global rather than per canvas.
-- Hand-written (project switched off Drizzle generator after 0020).
-- Additive only; frozen once any build ships it.

CREATE TABLE IF NOT EXISTS `canvas_library_items` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `vault_id` TEXT NOT NULL,
  `item_ciphertext` TEXT NOT NULL,
  `vector_clock` TEXT NOT NULL,
  `created_at` INTEGER NOT NULL,
  `updated_at` INTEGER NOT NULL,
  `deleted_at` INTEGER,
  `last_synced_at` INTEGER,
  `clock` TEXT
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `canvas_library_items_by_vault`
  ON `canvas_library_items` (`vault_id`, `updated_at`);
