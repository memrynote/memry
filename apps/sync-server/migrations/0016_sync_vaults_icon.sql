-- A vault's icon, sealed on the client like its name (protocol 04 section 4.16).
-- The server stores ciphertext and the client's change time and never sees the
-- icon. Written by PUT /sync/vaults/:vaultId/icon, last writer by
-- icon_updated_at wins.
--
-- Backward compatibility:
--   * Nullable, no default, no backfill. Every existing vault reads NULL in all
--     three columns, which clients draw as the default icon.
--   * A reset is a row with icon_updated_at set and both icon columns NULL, so
--     clearing an icon propagates like setting one.
--   * A Worker deployed before this migration (or rolled back after it) names
--     its columns explicitly and never reads these. Older clients ignore the
--     extra GET /sync/vaults fields.
ALTER TABLE sync_vaults ADD COLUMN encrypted_icon TEXT;
ALTER TABLE sync_vaults ADD COLUMN icon_nonce TEXT;
ALTER TABLE sync_vaults ADD COLUMN icon_updated_at INTEGER;
