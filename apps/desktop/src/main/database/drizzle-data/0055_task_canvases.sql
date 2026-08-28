-- Task-canvas links: the canvas half of the task drawer's "Related" list (#1849).
--
-- Additive only. One new table, no ALTER, no backfill, no DELETE. Existing
-- installs upgrade by gaining an empty table; every `tasks` row and every
-- `task_notes` row is left exactly as it is. Rollback is inert — an older build
-- never reads `task_canvases`, and its non-strict `TaskSyncPayloadSchema` drops
-- the unknown `linkedCanvasIds` key instead of failing the apply.
--
-- Mirrors `task_notes` column for column, including the absence of a foreign
-- key to `canvases`. A FK there would make sync apply order load-bearing: a
-- task arriving before the canvas it links to would fail the whole upsert. The
-- FK to `tasks` stays so deleting a task reclaims its links.
--
-- Hand-written (project switched off Drizzle generator after 0020).
CREATE TABLE IF NOT EXISTS `task_canvases` (
	`task_id` text NOT NULL,
	`canvas_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`task_id`, `canvas_id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
