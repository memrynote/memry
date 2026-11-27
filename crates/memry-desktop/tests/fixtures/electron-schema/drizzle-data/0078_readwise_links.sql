-- Readwise links: device-local cache of Readwise item -> note (#1411, epic #1408).
--
-- Additive only: one new table, no change to an existing one. Never synced
-- (no clock, no handler); `readwise_url` on the note is the identity and
-- `rebuildLinks()` refills the table from it.
--
-- Rollback is inert: an older build never reads this table.
--
-- Hand-written (project switched off the Drizzle generator after 0020).
CREATE TABLE IF NOT EXISTS `readwise_links` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `readwise_book_id` integer,
  `reader_document_id` text,
  `note_id` text NOT NULL,
  `state` text DEFAULT 'linked' NOT NULL,
  `updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_readwise_links_book_id` ON `readwise_links` (`readwise_book_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_readwise_links_reader_document_id` ON `readwise_links` (`reader_document_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_readwise_links_note_id` ON `readwise_links` (`note_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_readwise_links_state` ON `readwise_links` (`state`);
