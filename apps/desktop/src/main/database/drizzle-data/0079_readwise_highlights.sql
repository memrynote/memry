-- Readwise highlights index: device-local record of the highlights this device
-- has seen (#3476, epic #1408 D17).
--
-- Additive only: one new table, no change to an existing one. Never synced
-- (no clock, no handler); a full Readwise export refills it.
--
-- Rollback is inert: an older build never reads this table.
--
-- Hand-written (project switched off the Drizzle generator after 0020).
CREATE TABLE IF NOT EXISTS `readwise_highlights` (
  `highlight_id` integer PRIMARY KEY NOT NULL,
  `book_id` integer NOT NULL,
  `highlighted_at` text,
  `created_at` text,
  `deleted` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_readwise_highlights_book_id` ON `readwise_highlights` (`book_id`);
