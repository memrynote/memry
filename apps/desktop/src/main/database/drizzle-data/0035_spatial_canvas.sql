-- Adds spatial canvas tables: canvases (encrypted scene snapshots) +
-- canvas_entity_refs (advisory entity-reference index).
-- Hand-written (project switched off Drizzle generator after 0020).
-- Additive only; frozen once any build ships it.

CREATE TABLE IF NOT EXISTS `canvases` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `vault_id` TEXT NOT NULL,
  `title` TEXT,
  `snapshot_ciphertext` TEXT NOT NULL,
  `vector_clock` TEXT NOT NULL,
  `created_at` INTEGER NOT NULL,
  `updated_at` INTEGER NOT NULL,
  `deleted_at` INTEGER,
  `last_synced_at` INTEGER,
  `clock` TEXT
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `canvases_by_vault`
  ON `canvases` (`vault_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `canvases_by_updated`
  ON `canvases` (`vault_id`, `updated_at`);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `canvas_entity_refs` (
  `canvas_id` TEXT NOT NULL,
  `entity_type` TEXT NOT NULL,
  `entity_id` TEXT NOT NULL,
  PRIMARY KEY (`canvas_id`, `entity_type`, `entity_id`),
  FOREIGN KEY (`canvas_id`) REFERENCES `canvases`(`id`) ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_canvas_refs_entity`
  ON `canvas_entity_refs` (`entity_type`, `entity_id`);
