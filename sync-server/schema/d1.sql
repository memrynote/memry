-- ============================================
-- Memry Sync Server - D1 Database Schema
-- Feature: 001-sync-e2ee-2
-- ============================================

-- T014: users table
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
  storage_limit INTEGER NOT NULL DEFAULT 5368709120,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_provider ON users(auth_provider, auth_provider_id)
  WHERE auth_provider IS NOT NULL;

-- T014a: otp_codes table
CREATE TABLE IF NOT EXISTS otp_codes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_otp_email ON otp_codes(email);
CREATE INDEX IF NOT EXISTS idx_otp_expires ON otp_codes(expires_at);

-- T015: devices table (before refresh_tokens due to FK)
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  os_version TEXT,
  app_version TEXT NOT NULL,
  auth_public_key TEXT NOT NULL,
  last_sync_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, auth_public_key)
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);

-- T014b: refresh_tokens table
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  rotated_at INTEGER,
  revoked_at INTEGER,  -- timestamp when revoked (NULL = not revoked)
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_device ON refresh_tokens(device_id);

-- T014c: user_identities table
CREATE TABLE IF NOT EXISTS user_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(provider, provider_id)
);
CREATE INDEX IF NOT EXISTS idx_identity_user ON user_identities(user_id);

-- T016: linking_sessions table
CREATE TABLE IF NOT EXISTS linking_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  initiator_device_id TEXT NOT NULL REFERENCES devices(id),
  ephemeral_public_key TEXT NOT NULL,
  linking_token_hash TEXT NOT NULL,
  new_device_public_key TEXT,
  new_device_confirm TEXT,
  encrypted_master_key TEXT,
  encrypted_key_nonce TEXT,
  key_confirm TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_linking_user ON linking_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_linking_status ON linking_sessions(status) WHERE status IN ('pending', 'scanned');
CREATE INDEX IF NOT EXISTS idx_linking_expires ON linking_sessions(expires_at);

-- T017: sync_items table
CREATE TABLE IF NOT EXISTS sync_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL,
  item_id TEXT NOT NULL,
  encrypted_data BLOB NOT NULL,
  encrypted_key BLOB NOT NULL,
  key_nonce BLOB NOT NULL,
  data_nonce BLOB NOT NULL,
  clock TEXT NOT NULL,
  state_vector TEXT,
  deleted INTEGER DEFAULT 0,
  crypto_version INTEGER DEFAULT 1,
  size_bytes INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  signer_device_id TEXT NOT NULL REFERENCES devices(id),
  signature BLOB NOT NULL,
  server_cursor INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, item_type, item_id)
);
CREATE INDEX IF NOT EXISTS idx_sync_user_cursor ON sync_items(user_id, server_cursor);
CREATE INDEX IF NOT EXISTS idx_sync_type ON sync_items(user_id, item_type);
CREATE INDEX IF NOT EXISTS idx_sync_deleted ON sync_items(user_id, deleted);

-- T017a: server_cursor_sequence table
CREATE TABLE IF NOT EXISTS server_cursor_sequence (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  current_cursor INTEGER NOT NULL DEFAULT 0
);

-- T017b: device_sync_state table
CREATE TABLE IF NOT EXISTS device_sync_state (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_cursor_seen INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, user_id)
);

-- T017c: rate_limits table
CREATE TABLE IF NOT EXISTS rate_limits (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  count INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_key ON rate_limits(key);

-- T048: oauth_states table for PKCE flow
CREATE TABLE IF NOT EXISTS oauth_states (
  id TEXT PRIMARY KEY,
  state_hash TEXT NOT NULL UNIQUE,
  code_verifier TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_state_hash ON oauth_states(state_hash);
CREATE INDEX IF NOT EXISTS idx_oauth_expires ON oauth_states(expires_at);

-- T017e: crdt_updates table
CREATE TABLE IF NOT EXISTS crdt_updates (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note_id TEXT NOT NULL,
  update_data BLOB NOT NULL,
  sequence_num INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, note_id, sequence_num)
);
CREATE INDEX IF NOT EXISTS idx_crdt_updates_note ON crdt_updates(user_id, note_id, sequence_num);

-- T017f: crdt_snapshots table
CREATE TABLE IF NOT EXISTS crdt_snapshots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note_id TEXT NOT NULL,
  snapshot_data BLOB NOT NULL,
  sequence_num INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, note_id)
);
CREATE INDEX IF NOT EXISTS idx_crdt_snapshots_note ON crdt_snapshots(user_id, note_id);
