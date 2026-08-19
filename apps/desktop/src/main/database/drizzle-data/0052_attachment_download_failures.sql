-- Durable memory of attachment downloads that did not succeed.
--
-- Replaces an in-memory Set (cleared on every sync-runtime stop) as the guard
-- against re-requesting an attachment the server 404s, so the dead reference is
-- no longer re-probed on every launch. Rows are written from the download
-- OUTCOME and deleted as soon as it succeeds, so the table only holds live
-- failures.
--
-- Hand-written (project switched off Drizzle generator after 0020).
-- Additive only: a new table, no existing row touched. An older build simply
-- never reads it and behaves exactly as it does today.

CREATE TABLE IF NOT EXISTS `attachment_download_failures` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `owner_id` TEXT NOT NULL,
  `attachment_id` TEXT NOT NULL,
  `reason` TEXT NOT NULL,
  `attempts` INTEGER NOT NULL DEFAULT 0,
  `last_error` TEXT,
  `next_attempt_at` INTEGER,
  `updated_at` INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_attachment_download_failures_owner`
  ON `attachment_download_failures` (`owner_id`);
