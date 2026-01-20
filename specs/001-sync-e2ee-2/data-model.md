# Data Model: Sync Engine & E2EE

**Feature**: 001-sync-e2ee-2 | **Date**: 2026-01-14

This document defines all entities, relationships, and state transitions for the sync and encryption system.

## Entity Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           ENTITY RELATIONSHIPS                           │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────┐        ┌──────────┐        ┌──────────┐                   │
│  │   User   │───1:N──│  Device  │        │  Vault   │                   │
│  │ Account  │        │          │        │          │                   │
│  └────┬─────┘        └────┬─────┘        └────┬─────┘                   │
│       │                   │                   │                          │
│       │                   │                   │                          │
│       │              ┌────┴─────┐        ┌────┴─────┐                   │
│       │              │ Linking  │        │ Sync     │                   │
│       │              │ Session  │        │ Queue    │                   │
│       │              └──────────┘        └──────────┘                   │
│       │                                                                  │
│       └─────────────────────1:N───────────────────────┐                 │
│                                                       │                  │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌─────┴────┐             │
│  │   Note   │   │   Task   │   │ Project  │   │ Sync Item │             │
│  │ (CRDT)   │   │ (VClock) │   │ (VClock) │   │ (Server)  │             │
│  └────┬─────┘   └──────────┘   └──────────┘   └──────────┘             │
│       │                                                                  │
│       └────────────1:N────────────┐                                     │
│                                   │                                      │
│                            ┌──────┴─────┐                               │
│                            │ Attachment │                               │
│                            │  (Chunks)  │                               │
│                            └────────────┘                               │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Key Derivation Hierarchy

The master key is derived from the BIP39 recovery phrase and used to derive all other keys via HKDF.

```
Recovery Phrase (24 words)
        │
        ▼ BIP39 → Seed (64 bytes)
        │
        ▼ Argon2id (kdf_salt from server, plaintext)
        │
   Master Key (32 bytes)
        │
        ├──► HKDF("memry-vault-key-v1") ──► Vault Key (32 bytes)
        │                                        │
        │                                        └──► Wraps per-item random File Keys
        │
        ├──► HKDF("memry-signing-key-v1") ──► Ed25519 Seed (32 bytes)
        │                                        │
        │                                        └──► Ed25519 Keypair (user-level, for future use)
        │
        [Device-Level Signing Keys]
        Device generates Ed25519 keypair locally (not derived from master key)
        Public key registered with server in devices.auth_public_key
        Private key stored in OS keychain
        Used for signing all sync items (signer_device_id metadata)
        │
        └──► HKDF("memry-verify-key-v1") ──► Verify Key (32 bytes)
                                                 │
                                                 └──► HMAC-SHA-256 key verifier
```

### HKDF Context Strings

All HKDF derivations use SHA-256 with the following parameters:

```typescript
const HKDF_CONTEXTS = {
  // Key for encrypting/decrypting file keys
  VAULT_KEY: 'memry-vault-key-v1',

  // Seed for Ed25519 signing keypair (user-level)
  SIGNING_KEY: 'memry-signing-key-v1',

  // Key verifier (stored server-side for recovery phrase checks)
  VERIFY_KEY: 'memry-verify-key-v1'
} as const

// HKDF parameters
const HKDF_PARAMS = {
  hash: 'SHA-256',
  salt: null,           // No salt (extracted from master key)
  keyLength: 32,        // 256 bits
}

// Example derivation
function deriveVaultKey(masterKey: Uint8Array): Uint8Array {
  return hkdf(masterKey, HKDF_CONTEXTS.VAULT_KEY, HKDF_PARAMS)
}

function deriveVerifyKey(masterKey: Uint8Array): Uint8Array {
  return hkdf(masterKey, HKDF_CONTEXTS.VERIFY_KEY, HKDF_PARAMS)
}

// Per-item file keys are random (32 bytes) and wrapped with the vault key.
// Key verifier stored on the server:
// keyVerifier = HMAC-SHA-256(deriveVerifyKey(masterKey), 'memry-key-verify-v1')
```

### Signature Scope

Ed25519 signatures cover all fields that influence decryption and merge behavior.
Use canonical CBOR (RFC 8949) for deterministic encoding across platforms.

```typescript
interface SignaturePayloadV1 {
  id: string                // Item UUID
  type: string              // Item type
  operation?: string        // create | update | delete (if applicable)
  cryptoVersion: number     // Algorithm version
  encryptedKey: string      // Wrapped file key (Base64)
  keyNonce: string          // Nonce for key wrapping (Base64)
  encryptedData: string     // The encrypted content (Base64)
  dataNonce: string         // Encryption nonce (Base64)
  metadata?: {
    clock?: VectorClock
    fieldClocks?: { [field: string]: VectorClock }
    stateVector?: string
  }
}

// Signature is computed as:
// signature = Ed25519.sign(canonicalEncode(SignaturePayloadV1), signingPrivateKey)

// Verification:
// 1. Reconstruct SignaturePayloadV1 from received data
// 2. Verify signature against the user's public signing key
```

### Canonical Encoding

All HMAC/signature inputs use canonical CBOR (RFC 8949, Section 4.2). The encoded bytes are
fed directly into HMAC-SHA-256 or Ed25519; do not sign JSON strings.

---

## 1. User Account

Represents a user identity created via passwordless email OTP or OAuth provider.

### Schema (Server - D1)

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,                          -- UUID
  email TEXT UNIQUE NOT NULL,                   -- User's email
  email_verified INTEGER NOT NULL DEFAULT 0,    -- Boolean (set to 1 after first successful OTP verification)
  auth_method TEXT NOT NULL,                    -- 'email' | 'oauth'
  auth_provider TEXT,                           -- 'google' | 'apple' | 'github' | NULL for email
  auth_provider_id TEXT,                        -- Provider's user ID (NULL for email auth)
  kdf_salt TEXT,                                -- KDF salt for master key (Base64, plaintext) - set after recovery phrase setup
  key_verifier TEXT,                            -- HMAC-SHA-256 verifier of master key (Base64) - set after recovery phrase setup
  storage_used INTEGER NOT NULL DEFAULT 0,      -- Bytes used
  storage_limit INTEGER NOT NULL DEFAULT 5368709120, -- 5GB default
  created_at INTEGER NOT NULL,                  -- Unix timestamp
  updated_at INTEGER NOT NULL                   -- Unix timestamp
);

CREATE UNIQUE INDEX idx_users_provider ON users(auth_provider, auth_provider_id)
  WHERE auth_provider IS NOT NULL;
```

### OTP Codes Table (Server - D1)

```sql
CREATE TABLE otp_codes (
  id TEXT PRIMARY KEY,                          -- UUID
  email TEXT NOT NULL,                          -- Email address (may not have user yet)
  code_hash TEXT NOT NULL,                      -- SHA-256 hash of 6-digit code
  created_at INTEGER NOT NULL,                  -- Unix timestamp
  expires_at INTEGER NOT NULL,                  -- Unix timestamp (created_at + 600 = 10 min)
  attempts INTEGER NOT NULL DEFAULT 0,          -- Failed verification attempts (max 5)
  used INTEGER NOT NULL DEFAULT 0               -- 1 if code was successfully verified
);

CREATE INDEX idx_otp_email ON otp_codes(email);
CREATE INDEX idx_otp_expires ON otp_codes(expires_at);
```

### TypeScript Type

```typescript
interface User {
  id: string
  email: string
  emailVerified: boolean
  authMethod: 'email' | 'oauth'
  authProvider?: 'google' | 'apple' | 'github'  // Only for OAuth users
  authProviderId?: string                        // Only for OAuth users
  kdfSalt?: string                               // Base64 (plaintext KDF salt) - set after recovery phrase setup
  keyVerifier?: string                           // Base64 (HMAC verifier) - set after recovery phrase setup
  storageUsed: number
  storageLimit: number
  createdAt: Date
  updatedAt: Date
}

// Client-safe user (excludes sensitive fields)
interface UserPublic {
  id: string
  email: string
  emailVerified: boolean
  authMethod: 'email' | 'oauth'
  authProvider?: 'google' | 'apple' | 'github'
  storageUsed: number
  storageLimit: number
  createdAt: Date
}

interface OtpCode {
  id: string
  email: string
  codeHash: string                               // SHA-256 hash of 6-digit code
  createdAt: Date
  expiresAt: Date
  attempts: number                               // Failed verification attempts
  used: boolean                                  // True if code was verified
}
```

### Validation Rules

- `email`: Valid email format, max 255 chars
- `authMethod`: Must be 'email' or 'oauth'
- `authProvider`: Required if authMethod is 'oauth', must be one of allowed providers
- `kdfSalt`: Base64-encoded, 16+ bytes when decoded (non-secret), nullable until recovery setup
- `keyVerifier`: Base64-encoded, 32 bytes when decoded, nullable until recovery setup
- `storageUsed`: >= 0, <= storageLimit

### OTP Security Rules

- **Code format**: 6 digits (000000-999999)
- **Code expiry**: 10 minutes from creation
- **Max attempts**: 5 failed attempts per code (then code is invalidated)
- **Rate limit**: Max 3 OTP requests per 10 minutes per email
- **Hash storage**: SHA-256 of code (not plaintext)

---

## 2. Device

Represents a linked client device.

### Schema (Server - D1)

```sql
CREATE TABLE devices (
  id TEXT PRIMARY KEY,                          -- UUID
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                           -- User-friendly name
  platform TEXT NOT NULL,                       -- 'macos' | 'windows' | 'linux' | 'ios' | 'android'
  os_version TEXT,                              -- e.g., '14.0', '11'
  app_version TEXT NOT NULL,                    -- e.g., '1.0.0'
  auth_public_key TEXT NOT NULL,                 -- Device signing public key (Base64, Ed25519) - REQUIRED for sync item verification
  push_token TEXT,                              -- For push notifications (optional)
  created_at INTEGER NOT NULL,
  last_sync_at INTEGER,
  revoked_at INTEGER                            -- Soft delete
);

CREATE INDEX idx_devices_user ON devices(user_id);
CREATE INDEX idx_devices_user_active ON devices(user_id) WHERE revoked_at IS NULL;
```

### Schema (Local - SQLite via Drizzle)

```typescript
export const devices = sqliteTable('devices', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  platform: text('platform').notNull(),
  osVersion: text('os_version'),
  appVersion: text('app_version').notNull(),
  linkedAt: integer('linked_at', { mode: 'timestamp' }).notNull(),
  lastSyncAt: integer('last_sync_at', { mode: 'timestamp' }),
  isCurrentDevice: integer('is_current_device', { mode: 'boolean' }).default(false)
})
```

### TypeScript Type

```typescript
interface Device {
  id: string
  userId?: string                 // Only on server
  name: string
  platform: 'macos' | 'windows' | 'linux' | 'ios' | 'android'
  osVersion?: string
  appVersion: string
  authPublicKey: string           // Device signing public key (Base64, Ed25519) - required for sync item verification
  linkedAt: Date
  lastSyncAt?: Date
  isCurrentDevice?: boolean       // Only on client
  revokedAt?: Date               // Only on server
}
```

### State Transitions

```
                    ┌─────────────┐
                    │   Created   │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
          ┌─────────│   Active    │──────────┐
          │         └──────┬──────┘          │
          │                │                 │
    (sync success)   (sync success)    (user removes)
          │                │                 │
          └────────►┌──────▼──────┐          │
                    │   Active    │◄─────────┘
                    └──────┬──────┘
                           │ (user revokes)
                    ┌──────▼──────┐
                    │   Revoked   │
                    └─────────────┘
```

---

## 3. Linking Session

Temporary session for device linking via QR code.

### Schema (Server - D1)

```sql
CREATE TABLE linking_sessions (
  id TEXT PRIMARY KEY,                          -- UUID
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  initiator_device_id TEXT NOT NULL REFERENCES devices(id),
  ephemeral_public_key TEXT NOT NULL,           -- X25519 public key (Base64)
  new_device_public_key TEXT,                   -- Set when new device scans
  new_device_confirm TEXT,                      -- HMAC proof from new device (Base64)
  encrypted_master_key TEXT,                    -- Set when approved
  encrypted_key_nonce TEXT,                     -- Nonce for encrypted key
  key_confirm TEXT,                             -- HMAC confirmation for encrypted key (Base64)
  status TEXT NOT NULL DEFAULT 'pending',       -- 'pending' | 'scanned' | 'approved' | 'completed' | 'expired'
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,                  -- 5 minutes from creation
  completed_at INTEGER
);

CREATE INDEX idx_linking_user ON linking_sessions(user_id);
CREATE INDEX idx_linking_status ON linking_sessions(status) WHERE status IN ('pending', 'scanned');
```

### TypeScript Type

```typescript
interface LinkingSession {
  id: string
  userId: string
  initiatorDeviceId: string
  ephemeralPublicKey: string      // Base64
  newDevicePublicKey?: string     // Base64, set after scan
  newDeviceConfirm?: string       // Base64, proof of possession
  encryptedMasterKey?: string     // Base64, set after approval
  encryptedKeyNonce?: string      // Base64
  keyConfirm?: string             // Base64, key confirmation
  status: 'pending' | 'scanned' | 'approved' | 'completed' | 'expired'
  createdAt: Date
  expiresAt: Date
  completedAt?: Date
}
```

### State Transitions

```
┌─────────┐     scan      ┌─────────┐    approve   ┌──────────┐   complete  ┌───────────┐
│ Pending │──────────────►│ Scanned │─────────────►│ Approved │────────────►│ Completed │
└────┬────┘               └────┬────┘              └──────────┘             └───────────┘
     │                         │
     │ (timeout)               │ (timeout)
     │                         │
     └────────►┌─────────┐◄────┘
               │ Expired │
               └─────────┘
```

Linking uses per-session X25519 ECDH between the existing device's ephemeral key and the new
device's ephemeral key. The new device submits `new_device_confirm` (HMAC proof) so the
existing device can verify possession before approval. The existing device returns
`key_confirm` so the new device can verify the encrypted master key on completion.

### Linking Handshake (QR)

1. Existing device generates an ephemeral X25519 keypair and a one-time token, then creates
   a linking session. QR payload includes: `session_id`, `token`, `ephemeral_public_key`.
2. New device generates its ephemeral X25519 keypair and computes:
   `shared = X25519(new_priv, ephemeral_public_key)`.
   Derive `enc_key = HKDF(shared, 'memry-linking-enc-v1')` and
   `mac_key = HKDF(shared, 'memry-linking-mac-v1')`.
3. New device posts `new_device_public_key` and
   `new_device_confirm = HMAC(mac_key, canonicalEncode({ session_id, token, new_device_public_key }))`.
4. Existing device fetches the session, computes the same `shared`, verifies
   `new_device_confirm`, then encrypts the master key with `enc_key`.
5. Existing device posts `encrypted_master_key`, `nonce`, and
   `key_confirm = HMAC(mac_key, canonicalEncode({ session_id, encrypted_master_key, nonce }))`.
6. New device completes the session, verifies `key_confirm`, then decrypts and stores the
   master key.

---

## 4. Sync Queue Item

Local queue for pending sync operations.

### Schema (Local - SQLite via Drizzle)

```typescript
export const syncQueue = sqliteTable('sync_queue', {
  id: text('id').primaryKey(),                                    // UUID
  type: text('type').notNull(),                                   // 'note_update' | 'task' | 'project' | 'settings' | 'attachment'
  itemId: text('item_id').notNull(),                             // ID of synced item
  operation: text('operation').notNull(),                        // 'create' | 'update' | 'delete'
  payload: text('payload').notNull(),                            // Encrypted JSON
  priority: integer('priority').default(0),                       // Higher = more urgent
  attempts: integer('attempts').default(0),
  lastAttempt: integer('last_attempt', { mode: 'timestamp' }),
  errorMessage: text('error_message'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull()
})

// Indexes
export const syncQueueIndexes = {
  byType: index('sync_queue_type_idx').on(syncQueue.type),
  byCreated: index('sync_queue_created_idx').on(syncQueue.createdAt)
}
```

### TypeScript Type

```typescript
interface SyncQueueItem {
  id: string
  type: 'note_update' | 'task' | 'project' | 'settings' | 'attachment'
  itemId: string
  operation: 'create' | 'update' | 'delete'
  payload: string                 // Encrypted JSON (Base64)
  priority: number
  attempts: number
  lastAttempt?: Date
  errorMessage?: string
  createdAt: Date
}
```

---

## 5. Sync Item (Server)

Server-side metadata for synced items.

### Schema (Server - D1)

```sql
CREATE TABLE sync_items (
  id TEXT PRIMARY KEY,                          -- UUID (same as client item ID)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,                           -- 'note' | 'task' | 'project' | 'settings' | 'attachment'
  blob_key TEXT NOT NULL,                       -- R2 object key
  size INTEGER NOT NULL,                        -- Blob size in bytes
  version INTEGER NOT NULL DEFAULT 1,           -- Incremented on each update
  server_cursor INTEGER NOT NULL,               -- Monotonic, auto-incrementing cursor for change feed ordering
  signer_device_id TEXT NOT NULL,               -- Device that signed this item (FK to devices.id)
  signature TEXT NOT NULL,                      -- Ed25519 signature (Base64)
  state_vector TEXT,                            -- For CRDT items (Yjs state vector, Base64)
  clock TEXT,                                   -- For non-CRDT items (JSON vector clock)
  created_at INTEGER NOT NULL,
  modified_at INTEGER NOT NULL,
  deleted_at INTEGER                            -- Soft delete
);

CREATE INDEX idx_sync_items_user ON sync_items(user_id);
CREATE INDEX idx_sync_items_user_type ON sync_items(user_id, type);
CREATE INDEX idx_sync_items_modified ON sync_items(user_id, modified_at);
CREATE INDEX idx_sync_items_cursor ON sync_items(user_id, server_cursor);

-- Tracks each device's sync progress via server_cursor
CREATE TABLE device_sync_state (
  device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  last_cursor_seen INTEGER NOT NULL DEFAULT 0,   -- Last server_cursor this device has processed
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_device_sync_state_device ON device_sync_state(device_id);
```

### TypeScript Type

```typescript
interface SyncItem {
  id: string
  userId: string
  type: 'note' | 'task' | 'project' | 'settings' | 'attachment'
  blobKey: string
  size: number
  version: number
  serverCursor: number            // Monotonic cursor for change feed ordering
  signerDeviceId: string          // Device that signed this item
  signature: string               // Ed25519 signature (Base64)
  stateVector?: string            // For notes (Yjs)
  clock?: VectorClock             // For tasks/projects
  createdAt: Date
  modifiedAt: Date
  deletedAt?: Date
}

interface DeviceSyncState {
  deviceId: string
  lastCursorSeen: number          // Last server_cursor this device has processed
  updatedAt: Date
}
```

---

## 6. Encrypted Item

Structure of encrypted content stored in R2.

### Crypto Algorithm Versioning

All encrypted items include a version field for algorithm agility:

```typescript
type CryptoVersion = 1  // Current version

// Version 1 algorithms:
// - Encryption: XChaCha20-Poly1305 (24-byte nonce)
// - Key Derivation: Argon2id (64MB, 3 iterations)
// - Signatures: Ed25519
// - Key Exchange: X25519
// - Hash: SHA-256

// Future versions can introduce new algorithms while
// maintaining backward compatibility for decryption
```

### TypeScript Type

```typescript
interface EncryptedItem {
  id: string                      // Item UUID
  type: 'note' | 'task' | 'project' | 'settings'
  cryptoVersion: number           // Algorithm version (currently 1)

  // Encrypted content
  encryptedKey: string            // File key encrypted with Vault Key (Base64)
  keyNonce: string                // Nonce for key encryption (Base64)
  encryptedData: string           // Content encrypted with File Key (Base64)
  dataNonce: string               // Nonce for data encryption (Base64)

  // Integrity - signature covers: id + type + cryptoVersion + encryptedKey + keyNonce +
  // encryptedData + dataNonce + clock/fieldClocks when present
  signature: string               // Ed25519 signature (Base64)
  signerDeviceId: string          // Device ID that signed this item (for public key lookup)
  signedAt?: number               // Optional timestamp for diagnostics

  // Sync metadata (for non-CRDT items)
  clock?: VectorClock
  fieldClocks?: { [field: string]: VectorClock }
}

// For CRDT items (notes)
interface EncryptedCrdtItem {
  id: string
  type: 'note'

  // Encrypted Yjs state
  encryptedSnapshot: string       // Full Yjs state (Base64)
  snapshotNonce: string           // Nonce (Base64)
  stateVector: string             // Yjs state vector (unencrypted for sync protocol)

  // File key
  encryptedKey: string
  keyNonce: string

  // Integrity
  signature: string               // Signature includes encryptedSnapshot + snapshotNonce + stateVector + encryptedKey

  // Incremental updates
  updates: EncryptedUpdate[]
}

interface EncryptedUpdate {
  encryptedData: string           // Yjs update (Base64)
  nonce: string
  timestamp: number
  signature: string               // Signature includes note id + encryptedData + nonce + timestamp
}
```

---

## 7. Attachment

Binary file attached to notes.

### Manifest Structure (Encrypted)

```typescript
interface AttachmentManifest {
  id: string                      // Attachment UUID
  filename: string                // Original filename
  mimeType: string
  size: number                    // Total bytes
  checksum: string                // SHA-256 of original file
  chunks: ChunkRef[]
  chunkSize: number               // 8MB (8388608)
  createdAt: number
}

interface EncryptedAttachmentManifest {
  encryptedManifest: string       // Base64 encrypted AttachmentManifest
  manifestNonce: string           // Nonce (Base64)
  encryptedFileKey: string        // File key encrypted with Vault Key (Base64)
  keyNonce: string                // Nonce for key encryption (Base64)
  manifestSignature: string       // Ed25519 signature over encryptedManifest + manifestNonce + encryptedFileKey + keyNonce
}

interface ChunkRef {
  index: number                   // Position in file (0-based)
  hash: string                    // SHA-256 of plaintext chunk
  encryptedHash: string           // SHA-256 of encrypted chunk (for R2 lookup)
  size: number                    // Actual chunk size
}
```

Chunks are encrypted with the attachment file key using AEAD and unique nonces.
Clients verify `encryptedHash` before decrypting and `hash` after decrypting.

### Reference Structure (In Note/Task)

```typescript
interface AttachmentRef {
  id: string                      // Attachment ID
  manifestId: string              // Points to encrypted manifest
  filename: string                // For display
  size: number                    // For progress display
  mimeType: string
  thumbnail?: string              // Base64 thumbnail for images/videos/PDFs
  createdAt: number
}
```

---

## 8. Sync State

Local sync state tracking.

### Schema (Local - SQLite via Drizzle)

```typescript
export const syncState = sqliteTable('sync_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull()
})
```

### Keys

```typescript
const SYNC_STATE_KEYS = {
  LAST_SYNC_AT: 'last_sync_at',           // Unix timestamp
  SYNC_STATUS: 'sync_status',             // 'idle' | 'syncing' | 'offline' | 'error'
  PENDING_COUNT: 'pending_count',         // Number of queued items
  LAST_ERROR: 'last_error',               // Last sync error message
  SERVER_CURSOR: 'server_cursor',         // Last server_cursor received from server (monotonic integer)
  DEVICE_CLOCK: 'device_clock',           // JSON - our vector clock
}
```

---

## 9. Sync History

Audit log of sync operations.

### Schema (Local - SQLite via Drizzle)

```typescript
export const syncHistory = sqliteTable('sync_history', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),           // 'push' | 'pull' | 'error'
  itemCount: integer('item_count').notNull(),
  direction: text('direction'),           // 'upload' | 'download'
  details: text('details'),               // JSON for errors or item breakdown
  durationMs: integer('duration_ms'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull()
})

export const syncHistoryIndex = index('sync_history_created_idx').on(syncHistory.createdAt)
```

### TypeScript Type

```typescript
interface SyncHistoryEntry {
  id: string
  type: 'push' | 'pull' | 'error'
  itemCount: number
  direction?: 'upload' | 'download'
  details?: {
    notes?: number
    tasks?: number
    attachments?: number
    error?: string
    failedItems?: string[]
  }
  durationMs?: number
  createdAt: Date
}
```

---

## 10. Inbox Item

Quick capture items that sync across devices.

### Schema (Local - SQLite via Drizzle)

```typescript
// Already exists in data-schema.ts, adding sync fields
export const inboxItems = sqliteTable('inbox_items', {
  id: text('id').primaryKey(),
  content: text('content').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  processedAt: integer('processed_at', { mode: 'timestamp' }),
  // Sync fields
  clock: text('clock'),                    // JSON vector clock
  syncedAt: integer('synced_at', { mode: 'timestamp' }),
  localOnly: integer('local_only', { mode: 'boolean' }).default(false),
})
```

### Sync Behavior

- Inbox items sync as encrypted blobs (like tasks)
- Use vector clock for conflict resolution (LWW)
- When processed (converted to task/note), both items sync

---

## 11. Saved Filter

Custom task filters that roam across devices.

### Schema (Local - SQLite via Drizzle)

```typescript
// Already exists in data-schema.ts, adding sync fields
export const savedFilters = sqliteTable('saved_filters', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  filter: text('filter').notNull(),        // JSON filter definition
  icon: text('icon'),
  color: text('color'),
  sortOrder: integer('sort_order').default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  // Sync fields
  clock: text('clock'),                    // JSON vector clock
  syncedAt: integer('synced_at', { mode: 'timestamp' }),
})
```

### Sync Behavior

- Filters sync as part of user settings
- Use vector clock for conflict resolution
- Sort order conflicts resolved by taking higher value

---

## 12. Synced Settings

User preferences that roam across devices.

### Schema

```typescript
interface SyncedSettings {
  // Synced across all devices
  general: {
    defaultView: 'inbox' | 'today' | 'upcoming' | 'all'
    weekStartsOn: 0 | 1 | 2 | 3 | 4 | 5 | 6  // Sunday = 0
    dateFormat: 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'YYYY-MM-DD'
    timeFormat: '12h' | '24h'
    language: string                          // ISO 639-1 code
  }

  tasks: {
    defaultProject: string | null             // Project ID
    defaultPriority: 1 | 2 | 3 | 4
    autoArchiveCompleted: boolean
    archiveAfterDays: number
  }

  notes: {
    defaultFolder: string
    autoSaveInterval: number                  // milliseconds
    spellCheck: boolean
  }

  sync: {
    autoSync: boolean
    syncOnStartup: boolean
    conflictResolution: 'local' | 'remote' | 'newest'
  }

  // NOT synced (device-specific)
  // - theme (light/dark/system)
  // - font size
  // - window position/size
  // - sidebar width
  // - keyboard shortcuts
}
```

### Sync Behavior

- Settings sync as a single encrypted blob
- Use vector clock at field level for merging
- Device-specific settings stored locally only

### Settings Sync Item

```typescript
interface SettingsSyncItem extends EncryptedItem {
  type: 'settings'
  // The encrypted payload contains SyncedSettings JSON
  fieldClocks: {
    'general.defaultView': VectorClock
    'general.weekStartsOn': VectorClock
    'tasks.defaultProject': VectorClock
    // ... per-field clocks for LWW merge
  }
}
```

---

## 13. Vector Clock

For tracking causality in non-CRDT items.

### TypeScript Type

```typescript
interface VectorClock {
  [deviceId: string]: number      // Logical timestamp per device
}

// Example
const clock: VectorClock = {
  'device-abc-123': 5,
  'device-def-456': 3
}
```

### Operations

```typescript
// Increment clock for local change
function incrementClock(clock: VectorClock, deviceId: string): VectorClock {
  return {
    ...clock,
    [deviceId]: (clock[deviceId] ?? 0) + 1
  }
}

// Merge two clocks (take max of each device)
function mergeClock(a: VectorClock, b: VectorClock): VectorClock {
  const merged: VectorClock = { ...a }
  for (const [device, time] of Object.entries(b)) {
    merged[device] = Math.max(merged[device] ?? 0, time)
  }
  return merged
}

// Compare clocks: -1 (a < b), 0 (concurrent), 1 (a > b)
function compareClock(a: VectorClock, b: VectorClock): -1 | 0 | 1 {
  const devices = new Set([...Object.keys(a), ...Object.keys(b)])

  let aGreater = false
  let bGreater = false

  for (const device of devices) {
    const aVal = a[device] ?? 0
    const bVal = b[device] ?? 0
    if (aVal > bVal) aGreater = true
    if (bVal > aVal) bGreater = true
  }

  if (aGreater && !bGreater) return 1
  if (bGreater && !aGreater) return -1
  return 0 // Concurrent
}
```

---

## Tombstone Retention Policy

Soft-deleted items (where `deleted_at` is set) are retained for cross-device propagation and potential recovery.

### Retention Rules

```typescript
const TOMBSTONE_POLICY = {
  // How long tombstones are kept after deletion
  retentionPeriod: 90 * 24 * 60 * 60 * 1000,  // 90 days in ms

  // Minimum sync window - tombstones younger than this are never purged
  minRetention: 7 * 24 * 60 * 60 * 1000,       // 7 days

  // How often to run cleanup job
  cleanupInterval: 24 * 60 * 60 * 1000,        // Daily

  // Batch size for cleanup operations
  cleanupBatchSize: 1000,
}
```

### Cleanup Process

```sql
-- Server-side cleanup job (runs daily)
-- 1. Find tombstones older than 90 days
SELECT id, blob_key FROM sync_items
WHERE deleted_at IS NOT NULL
  AND deleted_at < (strftime('%s', 'now') - 7776000) * 1000  -- 90 days ago
LIMIT 1000;

-- 2. Delete R2 blobs for each item
-- 3. Hard delete from sync_items
DELETE FROM sync_items WHERE id IN (...);

-- 4. For attachments, also delete orphaned chunks
DELETE FROM attachment_chunks
WHERE attachment_id NOT IN (SELECT id FROM sync_items WHERE type = 'attachment');
```

### Client-Side Handling

```typescript
// Client pulls tombstones to propagate deletes
interface DeletedItemRef {
  id: string
  type: string
  deletedAt: number
}

// When client sees a tombstone:
// 1. Delete local copy of item
// 2. Keep tombstone in local sync_state until next full sync
// 3. After 90 days, tombstone disappears from server responses
```

### GDPR Considerations

- **Right to Erasure**: Users can request immediate hard delete via support
- **Data Export**: Tombstones are excluded from data exports
- **Account Deletion**: All data (including tombstones) deleted within 30 days

---

## Entity Summary

| Entity | Storage | Encrypted | Sync Strategy |
|--------|---------|-----------|---------------|
| User | Server D1 | No (metadata only) | N/A |
| Device | Server D1 + Client SQLite | No | Server-managed |
| Linking Session | Server D1 | Partially | Server-managed |
| Sync Queue | Client SQLite | Yes (payload) | Local only |
| Sync Item | Server D1 + R2 | Yes (R2 blob) | Push/Pull |
| Note | Client files + R2 | Yes | CRDT (Yjs) |
| Task | Client SQLite + R2 | Yes | Vector Clock LWW |
| Project | Client SQLite + R2 | Yes | Vector Clock LWW |
| Inbox Item | Client SQLite + R2 | Yes | Vector Clock LWW |
| Saved Filter | Client SQLite + R2 | Yes | Vector Clock LWW |
| Settings | Client SQLite + R2 | Yes | Field-level Vector Clock |
| Attachment | Client files + R2 | Yes | Chunked |
| Sync State | Client SQLite | No | Local only |
| Sync History | Client SQLite | No | Local only |
