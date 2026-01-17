-- Memry Sync Server D1 Schema
-- This file contains the database schema for the sync server.
-- Run: wrangler d1 execute memry-sync --file=./schema/d1.sql

-- =============================================================================
-- T014: Users Table
-- =============================================================================
-- User accounts with authentication data and encryption key metadata.
-- The kdf_salt is stored in plaintext and used for Argon2id key derivation.
-- The key_verifier is an HMAC that allows validating recovery phrases.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,                          -- UUID
  email TEXT UNIQUE NOT NULL,                   -- User's email address
  email_verified INTEGER NOT NULL DEFAULT 0,    -- Boolean: email verified?
  auth_method TEXT NOT NULL,                    -- 'email' | 'oauth'
  auth_provider TEXT,                           -- 'google' | NULL
  auth_provider_id TEXT,                        -- Provider's user ID (NULL for email auth)
  password_hash TEXT,                           -- Argon2id hash (only for email auth)
  password_salt TEXT,                           -- Salt for password hash (only for email auth)
  kdf_salt TEXT NOT NULL,                       -- KDF salt for master key derivation (Base64, plaintext)
  key_verifier TEXT NOT NULL,                   -- HMAC-SHA-256 verifier of master key (Base64)
  email_verification_token TEXT,                -- Token for email verification
  email_verification_expires INTEGER,           -- Token expiry timestamp (Unix ms)
  password_reset_token TEXT,                    -- Token for password reset
  password_reset_expires INTEGER,               -- Token expiry timestamp (Unix ms)
  storage_used INTEGER NOT NULL DEFAULT 0,      -- Bytes of storage used
  storage_limit INTEGER NOT NULL DEFAULT 5368709120, -- 5GB default limit
  created_at INTEGER NOT NULL,                  -- Unix timestamp (ms)
  updated_at INTEGER NOT NULL                   -- Unix timestamp (ms)
);

-- Index for OAuth provider lookups
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_provider
  ON users(auth_provider, auth_provider_id)
  WHERE auth_provider IS NOT NULL;

-- Index for email verification token lookups
CREATE INDEX IF NOT EXISTS idx_users_email_verification
  ON users(email_verification_token)
  WHERE email_verification_token IS NOT NULL;

-- Index for password reset token lookups
CREATE INDEX IF NOT EXISTS idx_users_password_reset
  ON users(password_reset_token)
  WHERE password_reset_token IS NOT NULL;

-- =============================================================================
-- T015: Devices Table
-- =============================================================================
-- Linked client devices for each user account.
-- Each device can have an optional auth_public_key for device-level authentication.

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,                          -- UUID
  user_id TEXT NOT NULL,                        -- FK to users
  name TEXT NOT NULL,                           -- User-friendly device name
  platform TEXT NOT NULL,                       -- 'macos' | 'windows' | 'linux' | 'ios' | 'android'
  os_version TEXT,                              -- e.g., '14.0', '11', 'Sonoma'
  app_version TEXT NOT NULL,                    -- e.g., '1.0.0'
  auth_public_key TEXT,                         -- Optional device auth public key (Base64)
  push_token TEXT,                              -- For push notifications (optional)
  created_at INTEGER NOT NULL,                  -- Unix timestamp (ms)
  last_sync_at INTEGER,                         -- Last successful sync timestamp (ms)
  revoked_at INTEGER,                           -- Soft delete timestamp (ms)
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Index for finding devices by user
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);

-- Index for finding active (non-revoked) devices by user
CREATE INDEX IF NOT EXISTS idx_devices_user_active
  ON devices(user_id)
  WHERE revoked_at IS NULL;

-- =============================================================================
-- T016: Linking Sessions Table
-- =============================================================================
-- Temporary sessions for QR code device linking.
-- Sessions expire after 5 minutes and use X25519 ECDH for secure key transfer.

CREATE TABLE IF NOT EXISTS linking_sessions (
  id TEXT PRIMARY KEY,                          -- UUID
  user_id TEXT NOT NULL,                        -- FK to users
  initiator_device_id TEXT NOT NULL,            -- FK to devices (existing device)
  ephemeral_public_key TEXT NOT NULL,           -- X25519 public key from existing device (Base64)
  token_hash TEXT NOT NULL,                     -- SHA-256 hash of QR token for polling validation
  new_device_public_key TEXT,                   -- X25519 public key from new device (Base64)
  new_device_confirm TEXT,                      -- HMAC proof from new device (Base64)
  device_name TEXT,                             -- New device name (for approval UI)
  device_platform TEXT,                         -- New device platform: 'macos'|'windows'|'linux'|'ios'|'android'
  encrypted_master_key TEXT,                    -- Master key encrypted with shared secret (Base64)
  encrypted_key_nonce TEXT,                     -- Nonce for encrypted key (Base64)
  key_confirm TEXT,                             -- HMAC confirmation for encrypted key (Base64)
  status TEXT NOT NULL DEFAULT 'pending',       -- 'pending' | 'scanned' | 'approved' | 'completed' | 'rejected' | 'expired'
  created_at INTEGER NOT NULL,                  -- Unix timestamp (ms)
  expires_at INTEGER NOT NULL,                  -- Expiry timestamp (5 min from creation)
  completed_at INTEGER,                         -- Completion timestamp (ms)
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (initiator_device_id) REFERENCES devices(id) ON DELETE CASCADE
);

-- Index for finding sessions by user
CREATE INDEX IF NOT EXISTS idx_linking_sessions_user ON linking_sessions(user_id);

-- Index for finding active sessions
CREATE INDEX IF NOT EXISTS idx_linking_sessions_status
  ON linking_sessions(status)
  WHERE status IN ('pending', 'scanned');

-- Index for cleanup of expired sessions
CREATE INDEX IF NOT EXISTS idx_linking_sessions_expires ON linking_sessions(expires_at);

-- =============================================================================
-- T017: Sync Items Table
-- =============================================================================
-- Metadata for encrypted items stored in R2.
-- The actual encrypted content is stored in R2, referenced by blob_key.

CREATE TABLE IF NOT EXISTS sync_items (
  id TEXT PRIMARY KEY,                          -- UUID (same as client item ID)
  user_id TEXT NOT NULL,                        -- FK to users
  type TEXT NOT NULL,                           -- 'note' | 'task' | 'project' | 'settings' | 'attachment' | 'inbox_item' | 'saved_filter'
  blob_key TEXT NOT NULL,                       -- R2 object key for encrypted blob
  size INTEGER NOT NULL,                        -- Blob size in bytes
  version INTEGER NOT NULL DEFAULT 1,           -- Incremented on each update
  state_vector TEXT,                            -- For CRDT items: Yjs state vector (Base64)
  clock TEXT,                                   -- For non-CRDT items: JSON vector clock
  created_at INTEGER NOT NULL,                  -- Unix timestamp (ms)
  modified_at INTEGER NOT NULL,                 -- Unix timestamp (ms)
  deleted_at INTEGER,                           -- Soft delete timestamp (ms)
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Index for finding items by user
CREATE INDEX IF NOT EXISTS idx_sync_items_user ON sync_items(user_id);

-- Index for finding items by user and type
CREATE INDEX IF NOT EXISTS idx_sync_items_user_type ON sync_items(user_id, type);

-- Index for incremental sync (items modified since timestamp)
CREATE INDEX IF NOT EXISTS idx_sync_items_modified ON sync_items(user_id, modified_at);

-- Index for finding deleted items (tombstones)
CREATE INDEX IF NOT EXISTS idx_sync_items_deleted
  ON sync_items(deleted_at)
  WHERE deleted_at IS NOT NULL;

-- =============================================================================
-- Attachment Chunks Table (for deduplication)
-- =============================================================================
-- Tracks chunk references for content-addressable storage.
-- Multiple attachments can reference the same chunk.

CREATE TABLE IF NOT EXISTS attachment_chunks (
  id TEXT PRIMARY KEY,                          -- SHA-256 hash of encrypted chunk
  user_id TEXT NOT NULL,                        -- FK to users
  size INTEGER NOT NULL,                        -- Chunk size in bytes
  reference_count INTEGER NOT NULL DEFAULT 1,   -- Number of attachments using this chunk
  created_at INTEGER NOT NULL,                  -- Unix timestamp (ms)
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Index for finding chunks by user
CREATE INDEX IF NOT EXISTS idx_attachment_chunks_user ON attachment_chunks(user_id);

-- =============================================================================
-- Rate Limiting Table
-- =============================================================================
-- Tracks rate limit state for various operations.

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,                         -- e.g., 'login:user@example.com' or 'signup:192.168.1.1'
  count INTEGER NOT NULL DEFAULT 1,             -- Request count
  window_start INTEGER NOT NULL,                -- Window start timestamp (ms)
  expires_at INTEGER NOT NULL                   -- When this entry can be cleaned up
);

-- Index for cleanup of expired entries
CREATE INDEX IF NOT EXISTS idx_rate_limits_expires ON rate_limits(expires_at);
