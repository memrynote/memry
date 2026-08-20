CREATE TABLE IF NOT EXISTS `recently_opened` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`item_type` text NOT NULL,
	`opened_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_recently_opened_item` ON `recently_opened` (`item_type`,`item_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_recently_opened_opened` ON `recently_opened` (`opened_at`);--> statement-breakpoint
-- One-time hand-off: `search_reasons` already holds up to 20 command-palette
-- opens with a visited_at. Seeding from it means the widget is not born empty
-- on an existing install. This is a copy, not a link — the two tables diverge
-- from here on.
INSERT OR IGNORE INTO `recently_opened` (`id`, `item_id`, `item_type`, `opened_at`)
SELECT 'ro_' || `id`, `item_id`, `item_type`, `visited_at`
FROM `search_reasons`
WHERE `item_type` = 'note';
