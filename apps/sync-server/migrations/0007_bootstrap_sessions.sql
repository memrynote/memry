-- Bootstrap session ledger (#1837, P1.2 of the bootstrap-sync epic).
--
-- The bootstrap session TOKEN itself is stateless (HMAC-SHA256 over
-- {userId, deviceId, vaultId, jti, iat, exp} — see services/bootstrap-session.ts),
-- so the hot verification path inside the rate limiter's elevation seam reads
-- NOTHING here. This table exists only for what statelessness cannot express:
--
--   * the per-user concurrent session cap (MAX 2 active): issuance counts the
--     live rows for the user before minting a token
--   * explicit revocation: vault deletion removes every session scoped to that
--     vault (services/vault-deletion.ts) and /sync/bootstrap/close removes
--     the caller's own row.
--
-- Rows are pruned lazily at issuance (same user only) and by the cron sweep
-- (cleanup_expired_bootstrap_sessions), so an abandoned session costs one row
-- until its expiry passes — never a live ceiling.
--
-- Backward compatibility (mandatory -- real users on real data): a new EMPTY
-- table. Servers deployed before this migration never read or write it and old
-- clients never send a bootstrap header, so behavior is unchanged until a new
-- client deliberately opens a session.

CREATE TABLE IF NOT EXISTS bootstrap_sessions (
  jti TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  vault_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- Cap check + lazy prune both filter by user and expiry.
CREATE INDEX IF NOT EXISTS idx_bootstrap_sessions_user_expires
  ON bootstrap_sessions(user_id, expires_at);

-- Vault-switch revocation deletes per (user, vault).
CREATE INDEX IF NOT EXISTS idx_bootstrap_sessions_vault
  ON bootstrap_sessions(user_id, vault_id);
