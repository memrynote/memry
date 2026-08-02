-- Bookmark & reminder sync.
--
-- Adds vector-clock columns to both tables and rewrites identities that must be
-- deterministic across devices. Additive and row-preserving: no DELETE except
-- the duplicate collapse below, which is required for the PK rewrite to succeed.
-- Hand-written (project switched off Drizzle generator after 0020).

ALTER TABLE bookmarks ADD COLUMN clock TEXT;
--> statement-breakpoint
ALTER TABLE bookmarks ADD COLUMN synced_at TEXT;
--> statement-breakpoint
ALTER TABLE reminders ADD COLUMN clock TEXT;
--> statement-breakpoint
ALTER TABLE reminders ADD COLUMN synced_at TEXT;
--> statement-breakpoint
-- Bookmark ids become 'bmk_' || item_type || '_' || item_id.
--
-- Two-phase via a temp prefix so an incoming deterministic id can never
-- transiently collide with another row's not-yet-rewritten id.
--
-- idx_bookmarks_unique_item on (item_type, item_id) guarantees at most one row
-- per pair, so this mapping is strictly 1:1 — every row survives.
UPDATE bookmarks SET id = 'tmp0042_' || id;
--> statement-breakpoint
UPDATE bookmarks SET id = 'bmk_' || item_type || '_' || item_id;
--> statement-breakpoint
-- note_date reminders are derived from date pills and must be identical on
-- every device. Unlike bookmarks there is no unique index, so pre-existing
-- duplicates would collide on the PK rewrite. Collapse them first, keeping the
-- lowest id per (target_id, anchor_id).
DELETE FROM reminders
WHERE target_type = 'note_date'
  AND anchor_id IS NOT NULL
  AND id NOT IN (
    SELECT MIN(id) FROM reminders
    WHERE target_type = 'note_date' AND anchor_id IS NOT NULL
    GROUP BY target_id, anchor_id
  );
--> statement-breakpoint
UPDATE reminders SET id = 'tmp0042_' || id
WHERE target_type = 'note_date' AND anchor_id IS NOT NULL;
--> statement-breakpoint
UPDATE reminders SET id = 'rem_nd_' || target_id || '_' || anchor_id
WHERE target_type = 'note_date' AND anchor_id IS NOT NULL;
