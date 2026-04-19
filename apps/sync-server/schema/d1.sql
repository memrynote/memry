-- Memry Sync Server D1 Schema
-- All tables for sync, auth, devices, and CRDT support
-- Tables ordered by dependency (referenced tables first)

PRAGMA foreign_keys = ON;

-- ============================================================================
-- T014: Users
-- ============================================================================

CREATE TABLE users (
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

CREATE INDEX idx_users_email ON users(email);
CREATE UNIQUE INDEX idx_users_provider ON users(auth_provider, auth_provider_id) WHERE auth_provider IS NOT NULL;

-- ============================================================================
-- T014a: OTP codes
-- ============================================================================

CREATE TABLE otp_codes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_otp_email ON otp_codes(email);
CREATE INDEX idx_otp_expires ON otp_codes(expires_at);

-- ============================================================================
-- T014b: Refresh tokens (depends on users, devices)
-- Forward-declared: devices FK added after devices table via trigger/app logic
-- ============================================================================

-- Note: refresh_tokens references devices, but we need devices to exist first.
-- We create devices next, then refresh_tokens.

-- ============================================================================
-- T014c: User identities
-- ============================================================================

CREATE TABLE user_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (provider, provider_id)
);

CREATE INDEX idx_identity_user ON user_identities(user_id);

-- ============================================================================
-- T015: Devices
-- ============================================================================

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  os_version TEXT,
  app_version TEXT NOT NULL,
  auth_public_key TEXT NOT NULL,
  push_token TEXT,
  last_sync_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, auth_public_key)
);

CREATE INDEX idx_devices_user ON devices(user_id);
CREATE INDEX idx_devices_user_active ON devices(user_id) WHERE revoked_at IS NULL;

-- ============================================================================
-- T014b: Refresh tokens (now that devices exists)
-- ============================================================================

CREATE TABLE refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  rotated_at INTEGER,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_refresh_user ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_device ON refresh_tokens(device_id);

-- ============================================================================
-- T016: Linking sessions
-- ============================================================================

CREATE TABLE linking_sessions (
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
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX idx_linking_user ON linking_sessions(user_id);
CREATE INDEX idx_linking_expires ON linking_sessions(expires_at);
CREATE INDEX idx_linking_status ON linking_sessions(status) WHERE status IN ('pending', 'scanned');

-- ============================================================================
-- T017: Sync items (R2-backed, encrypted payloads stored in R2 via blob_key)
-- ============================================================================

CREATE TABLE sync_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
  UNIQUE (user_id, item_type, item_id)
);

CREATE INDEX idx_sync_user_cursor ON sync_items(user_id, server_cursor);
CREATE INDEX idx_sync_type ON sync_items(user_id, item_type);
CREATE INDEX idx_sync_deleted ON sync_items(user_id, deleted_at);

-- ============================================================================
-- T017a: Server cursor sequence (per-user monotonic cursor)
-- ============================================================================

CREATE TABLE server_cursor_sequence (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  current_cursor INTEGER NOT NULL DEFAULT 0
);

-- ============================================================================
-- T017b: Device sync state
-- ============================================================================

CREATE TABLE device_sync_state (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_cursor_seen INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, user_id)
);

-- ============================================================================
-- T017c: Rate limits
-- ============================================================================

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL
);

-- ============================================================================
-- T017e: CRDT updates
-- ============================================================================

CREATE TABLE crdt_updates (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note_id TEXT NOT NULL,
  update_data BLOB NOT NULL,
  sequence_num INTEGER NOT NULL,
  signer_device_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, note_id, sequence_num)
);

CREATE INDEX idx_crdt_updates_note ON crdt_updates(user_id, note_id, sequence_num);

-- ============================================================================
-- T017f: CRDT snapshots
-- ============================================================================

CREATE TABLE crdt_snapshots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note_id TEXT NOT NULL,
  blob_key TEXT NOT NULL,
  sequence_num INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  signer_device_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, note_id)
);

CREATE INDEX idx_crdt_snapshots_note ON crdt_snapshots(user_id, note_id);

-- ============================================================================
-- T017h: Upload sessions (chunked upload tracking)
-- ============================================================================

CREATE TABLE upload_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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

CREATE INDEX idx_upload_user ON upload_sessions(user_id);
CREATE INDEX idx_upload_expires ON upload_sessions(expires_at);

-- ============================================================================
-- T017i: Blob chunks (content-addressable dedup)
-- ============================================================================

CREATE TABLE blob_chunks (
  id TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  ref_count INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, hash)
);

CREATE INDEX idx_blob_chunks_hash ON blob_chunks(hash);

-- ============================================================================
-- Consumed setup tokens (single-use enforcement)
-- ============================================================================

CREATE TABLE consumed_setup_tokens (
  jti TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_consumed_tokens_expires ON consumed_setup_tokens(expires_at);

-- ============================================================================
-- M4: Google Calendar push channels
-- One row per active events.watch subscription registered by a device.
-- token_hash = HMAC-SHA256(WEBHOOK_HMAC_KEY, plaintext_token); the plaintext
-- token is known only to the registering device and Google.
-- ============================================================================

CREATE TABLE google_calendar_channels (
  channel_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  resource_id TEXT,
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_google_channels_user ON google_calendar_channels(user_id);
CREATE INDEX idx_google_channels_expires ON google_calendar_channels(expires_at);
