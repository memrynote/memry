-- 0001_baseline: full sync-server D1 schema at the point of adopting wrangler
-- D1 migrations. Every statement is idempotent (IF NOT EXISTS) so applying this
-- baseline to an already-provisioned database (staging, production) is a no-op,
-- while a fresh database (local dev, a new environment) is fully provisioned.
--
-- Canonical schema now lives in this migrations/ directory. DO NOT edit an
-- already-applied migration; add a new NNNN_*.sql file for any schema change so
-- it flows through `wrangler d1 migrations apply` in the deploy workflows.
--
-- Note: CREATE TABLE IF NOT EXISTS does NOT add columns to a table that already
-- exists with an older shape. Pre-existing databases are reconciled to this
-- baseline out-of-band once (see migrations/README.md); from here every change
-- is a tracked migration.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  auth_method TEXT NOT NULL,
  auth_provider TEXT,
  auth_provider_id TEXT,
  kdf_salt TEXT,
  key_verifier TEXT,
  storage_used INTEGER NOT NULL DEFAULT 0,
  storage_limit INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_provider ON users(auth_provider, auth_provider_id) WHERE auth_provider IS NOT NULL;

CREATE TABLE IF NOT EXISTS otp_codes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_otp_email ON otp_codes(email);
CREATE INDEX IF NOT EXISTS idx_otp_expires ON otp_codes(expires_at);

CREATE TABLE IF NOT EXISTS user_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (provider, provider_id)
);

CREATE INDEX IF NOT EXISTS idx_identity_user ON user_identities(user_id);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  os_version TEXT,
  app_version TEXT NOT NULL,
  auth_public_key TEXT NOT NULL,
  vault_id TEXT,
  push_token TEXT,
  last_sync_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, auth_public_key)
);

CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);
CREATE INDEX IF NOT EXISTS idx_devices_user_active ON devices(user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_devices_user_vault ON devices(user_id, vault_id);

CREATE TABLE IF NOT EXISTS sync_entitlements (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL DEFAULT 'free',
  status TEXT NOT NULL DEFAULT 'inactive',
  source TEXT NOT NULL DEFAULT 'none',
  storage_limit INTEGER NOT NULL DEFAULT 0,
  max_file_size INTEGER NOT NULL DEFAULT 0,
  max_vaults INTEGER,
  version_history_days INTEGER NOT NULL DEFAULT 0,
  paddle_customer_id TEXT,
  paddle_subscription_id TEXT,
  paddle_transaction_id TEXT,
  expires_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_entitlements_subscription ON sync_entitlements(paddle_subscription_id);
CREATE INDEX IF NOT EXISTS idx_sync_entitlements_customer ON sync_entitlements(paddle_customer_id);

CREATE TABLE IF NOT EXISTS sync_vaults (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vault_id TEXT NOT NULL,
  encrypted_name TEXT,
  name_nonce TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, vault_id)
);

CREATE INDEX IF NOT EXISTS idx_sync_vaults_user ON sync_vaults(user_id);

CREATE TABLE IF NOT EXISTS paddle_webhook_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  rotated_at INTEGER,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_device ON refresh_tokens(device_id);

CREATE TABLE IF NOT EXISTS linking_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  initiator_device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  ephemeral_public_key TEXT NOT NULL,
  linking_secret_hash TEXT NOT NULL,
  scanner_ip TEXT,
  new_device_public_key TEXT,
  new_device_confirm TEXT,
  encrypted_master_key TEXT,
  encrypted_key_nonce TEXT,
  key_confirm TEXT,
  encrypted_provider_auth TEXT,
  encrypted_provider_auth_nonce TEXT,
  provider_auth_confirm TEXT,
  provider_auth_version INTEGER,
  encrypted_vault_transfer TEXT,
  encrypted_vault_transfer_nonce TEXT,
  vault_transfer_confirm TEXT,
  vault_transfer_version INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_linking_user ON linking_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_linking_expires ON linking_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_linking_status ON linking_sessions(status) WHERE status IN ('pending', 'scanned');

CREATE TABLE IF NOT EXISTS sync_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vault_id TEXT NOT NULL DEFAULT 'default',
  item_type TEXT NOT NULL,
  item_id TEXT NOT NULL,
  blob_key TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  crypto_version INTEGER NOT NULL DEFAULT 1,
  operation TEXT NOT NULL DEFAULT 'update',
  clock TEXT,
  state_vector TEXT,
  deleted_at INTEGER,
  signer_device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
  signature TEXT NOT NULL,
  server_cursor INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, vault_id, item_type, item_id)
);

CREATE INDEX IF NOT EXISTS idx_sync_user_cursor ON sync_items(user_id, vault_id, server_cursor);
CREATE INDEX IF NOT EXISTS idx_sync_type ON sync_items(user_id, vault_id, item_type);
CREATE INDEX IF NOT EXISTS idx_sync_deleted ON sync_items(user_id, vault_id, deleted_at);

CREATE TABLE IF NOT EXISTS server_cursor_sequence (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  current_cursor INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS device_sync_state (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vault_id TEXT NOT NULL DEFAULT 'default',
  last_cursor_seen INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, user_id, vault_id)
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS crdt_updates (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vault_id TEXT NOT NULL DEFAULT 'default',
  note_id TEXT NOT NULL,
  update_data BLOB NOT NULL,
  sequence_num INTEGER NOT NULL,
  signer_device_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, vault_id, note_id, sequence_num)
);

CREATE INDEX IF NOT EXISTS idx_crdt_updates_note ON crdt_updates(user_id, vault_id, note_id, sequence_num);

CREATE TABLE IF NOT EXISTS crdt_snapshots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vault_id TEXT NOT NULL DEFAULT 'default',
  note_id TEXT NOT NULL,
  blob_key TEXT NOT NULL,
  sequence_num INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  signer_device_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, vault_id, note_id)
);

CREATE INDEX IF NOT EXISTS idx_crdt_snapshots_note ON crdt_snapshots(user_id, vault_id, note_id);

CREATE TABLE IF NOT EXISTS upload_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vault_id TEXT NOT NULL DEFAULT 'default',
  attachment_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  total_size INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  uploaded_chunks TEXT NOT NULL DEFAULT '[]',
  r2_upload_id TEXT,
  r2_key TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_upload_user ON upload_sessions(user_id, vault_id);
CREATE INDEX IF NOT EXISTS idx_upload_expires ON upload_sessions(expires_at);

CREATE TABLE IF NOT EXISTS blob_chunks (
  id TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vault_id TEXT NOT NULL DEFAULT 'default',
  r2_key TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  ref_count INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, vault_id, hash)
);

CREATE INDEX IF NOT EXISTS idx_blob_chunks_hash ON blob_chunks(user_id, vault_id, hash);

CREATE TABLE IF NOT EXISTS consumed_setup_tokens (
  jti TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_consumed_tokens_expires ON consumed_setup_tokens(expires_at);

CREATE TABLE IF NOT EXISTS google_calendar_channels (
  channel_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  resource_id TEXT,
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_google_channels_user ON google_calendar_channels(user_id);
CREATE INDEX IF NOT EXISTS idx_google_channels_expires ON google_calendar_channels(expires_at);
