-- Adds canvas_assets: per-device dedup index + GC bookkeeping for externalized
-- canvas image assets (M5). content_hash = plaintext sha256 (dedup key);
-- chunk_hashes = encrypted chunk hashes (JSON) for server dereference.
-- Hand-written (project switched off Drizzle generator after 0020).
-- Additive only; frozen once any build ships it.

CREATE TABLE IF NOT EXISTS `canvas_assets` (
  `vault_id` TEXT NOT NULL,
  `canvas_id` TEXT NOT NULL,
  `content_hash` TEXT NOT NULL,
  `attachment_id` TEXT NOT NULL,
  `file_id` TEXT NOT NULL,
  `filename` TEXT NOT NULL,
  `mime_type` TEXT NOT NULL,
  `size_bytes` INTEGER NOT NULL,
  `chunk_hashes` TEXT NOT NULL,
  `created_at` INTEGER NOT NULL,
  PRIMARY KEY (`canvas_id`, `content_hash`),
  FOREIGN KEY (`canvas_id`) REFERENCES `canvases`(`id`) ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_canvas_assets_dedup`
  ON `canvas_assets` (`vault_id`, `content_hash`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_canvas_assets_attachment`
  ON `canvas_assets` (`attachment_id`);
