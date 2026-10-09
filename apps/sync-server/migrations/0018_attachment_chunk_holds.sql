-- Idempotent holds on attachment chunks (#3022, protocol 14 section 14.8).
--
-- ref_count counts uploads, so a device that reuses a stored image on a second
-- canvas has no way to add a reference without re-sending the bytes. A hold is
-- keyed by an opaque holder id the client derives per (canvas, image), so every
-- device that holds or releases the same pair writes the same row: a retry or a
-- second device is a no-op instead of a second count.
--
-- A chunk stays stored while ref_count > 0 or any hold names it. The orphan
-- reaper skips held chunks.
--
-- Backward compatibility:
--   * New table, no backfill. A chunk with no hold row behaves exactly as before.
--   * A Worker deployed before this migration (or rolled back after it) never
--     reads the table, so it reaps on ref_count alone, as before.
CREATE TABLE IF NOT EXISTS attachment_chunk_holds (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vault_id TEXT NOT NULL DEFAULT 'default',
  holder_id TEXT NOT NULL,
  chunk_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, vault_id, holder_id, chunk_hash)
);

CREATE INDEX IF NOT EXISTS idx_attachment_chunk_holds_chunk
  ON attachment_chunk_holds(user_id, vault_id, chunk_hash);
