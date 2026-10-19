-- Sticky drafts: unsent text from the desktop sticky, synced as `sticky_draft`
-- records (protocol chapter 13 §13.13).
--
-- Additive only: one new table, no change to an existing one.
--
-- Rollback is inert: an older build never declares `sticky_draft` in
-- `X-Memry-Sync-Types`, so the server never sends it one, and it never reads
-- this table.
--
-- Hand-written (project switched off the Drizzle generator after 0020).
CREATE TABLE IF NOT EXISTS `sticky_drafts` (
  `id` text PRIMARY KEY NOT NULL,
  `content` text NOT NULL,
  `kind` text NOT NULL,
  `created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  `modified_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  `clock` text,
  `synced_at` text
);
