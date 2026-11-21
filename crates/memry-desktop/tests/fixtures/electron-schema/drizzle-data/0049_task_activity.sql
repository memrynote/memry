-- Task activity: append-only audit trail per task (#122).
--
-- Additive only. One new table, no ALTER, no backfill, no DELETE. Existing
-- installs upgrade by gaining an empty table; every task keeps its rows exactly
-- as they are. An older app version that rolls back simply never reads the
-- table, and its sync client never asks for the `task_activity` item type
-- because type negotiation is per-request — so a downgrade is inert, not broken.
--
-- Deliberately NO foreign key to `tasks`. `task_notes`/`task_tags` cascade on
-- task delete; a cascade here would erase the `deleted` entry itself, which is
-- the one row most worth keeping. Peers would also re-push the rows as orphans
-- anyway. Orphan rows leave with the retention prune instead.
--
-- `created_at` is ISO-8601 UTC so it sorts lexicographically, which both the
-- composite index below and the retention cutoff comparison rely on.
--
-- Hand-written (project switched off Drizzle generator after 0020).
CREATE TABLE `task_activity` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`action` text NOT NULL,
	`field` text,
	`old_value` text,
	`new_value` text,
	`actor` text DEFAULT 'user' NOT NULL,
	`device_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`clock` text,
	`synced_at` text
);
--> statement-breakpoint
CREATE INDEX `task_activity_by_task` ON `task_activity` (`task_id`,`created_at`);
