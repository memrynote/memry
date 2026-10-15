-- Additive only: one new table, no existing table or row touched. A table
-- rather than a `journal_entries.aliases` column for 0005's reason: `ALTER
-- TABLE ... ADD COLUMN` has no `IF NOT EXISTS`, so a crash between this
-- migration's commit and the `user_version` write (§A.0) would make the re-run
-- fail forever. An older build never reads the table.
--
-- `aliases` is the payload's array as JSON text. No row, or a NULL, means the
-- payloads seen so far never carried the field.
CREATE TABLE IF NOT EXISTS journal_aliases (
  journal_id TEXT PRIMARY KEY,
  aliases    TEXT
);
