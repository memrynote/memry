-- Durable outbox for note-attachment uploads: a row is written before the
-- upload starts and deleted only after the server accepts the file, so a
-- failed or quit-interrupted upload is retried on the next sync runtime start
-- instead of being lost with the in-memory queue.
-- Hand-written (project switched off Drizzle generator after 0020).
-- Additive only; frozen once any build ships it.

CREATE TABLE IF NOT EXISTS `attachment_upload_queue` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `note_id` TEXT NOT NULL,
  `disk_path` TEXT NOT NULL,
  `attempts` INTEGER NOT NULL DEFAULT 0,
  `last_error` TEXT,
  `created_at` INTEGER NOT NULL,
  `updated_at` INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `attachment_upload_queue_note_path`
  ON `attachment_upload_queue` (`note_id`, `disk_path`);
