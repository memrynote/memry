# Data Model: Sync Engine & E2EE

**Feature**: 001-sync-e2ee | **Date**: 2026-01-14

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

## 1. User Account

Represents a user identity created via email/password or OAuth provider.

### Schema (Server - D1)

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,                          -- UUID
  email TEXT UNIQUE NOT NULL,                   -- User's email
  email_verified INTEGER NOT NULL DEFAULT 0,    -- Boolean
  auth_method TEXT NOT NULL,                    -- 'email' | 'oauth'
  auth_provider TEXT,                           -- 'google' | 'apple' | 'github' | NULL for email
  auth_provider_id TEXT,                        -- Provider's user ID (NULL for email auth)
  password_hash TEXT,                           -- Argon2id hash (only for email auth)
  password_salt TEXT,                           -- Salt for password hash (only for email auth)
  encrypted_salt TEXT NOT NULL,                 -- Salt encrypted with vault key (for E2EE)
  verification_hash TEXT NOT NULL,              -- Hash to verify master key
  email_verification_token TEXT,                -- Token for email verification
  email_verification_expires INTEGER,           -- Token expiry timestamp
  password_reset_token TEXT,                    -- Token for password reset
  password_reset_expires INTEGER,               -- Token expiry timestamp
  storage_used INTEGER NOT NULL DEFAULT 0,      -- Bytes used
  storage_limit INTEGER NOT NULL DEFAULT 5368709120, -- 5GB default
  created_at INTEGER NOT NULL,                  -- Unix timestamp
  updated_at INTEGER NOT NULL                   -- Unix timestamp
);

CREATE UNIQUE INDEX idx_users_provider ON users(auth_provider, auth_provider_id)
  WHERE auth_provider IS NOT NULL;
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
  passwordHash?: string                          // Only for email users (never sent to client)
  passwordSalt?: string                          // Only for email users (never sent to client)
  encryptedSalt: string                          // Base64 (for E2EE key derivation)
  verificationHash: string                       // Base64
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
```

### Validation Rules

- `email`: Valid email format, max 255 chars
- `authMethod`: Must be 'email' or 'oauth'
- `authProvider`: Required if authMethod is 'oauth', must be one of allowed providers
- `password` (for email auth): Min 12 chars, must contain uppercase, lowercase, number, special char
- `encryptedSalt`: Base64-encoded, 32+ bytes when decoded
- `storageUsed`: >= 0, <= storageLimit

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
  public_key TEXT NOT NULL,                     -- Ed25519 public key (Base64)
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
  publicKey?: string              // Only on server
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
  encrypted_master_key TEXT,                    -- Set when approved
  encrypted_key_nonce TEXT,                     -- Nonce for encrypted key
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
  encryptedMasterKey?: string     // Base64, set after approval
  encryptedKeyNonce?: string      // Base64
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
  state_vector TEXT,                            -- For CRDT items (Yjs state vector, Base64)
  clock TEXT,                                   -- For non-CRDT items (JSON vector clock)
  created_at INTEGER NOT NULL,
  modified_at INTEGER NOT NULL,
  deleted_at INTEGER                            -- Soft delete
);

CREATE INDEX idx_sync_items_user ON sync_items(user_id);
CREATE INDEX idx_sync_items_user_type ON sync_items(user_id, type);
CREATE INDEX idx_sync_items_modified ON sync_items(user_id, modified_at);
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
  stateVector?: string            // For notes (Yjs)
  clock?: VectorClock             // For tasks/projects
  createdAt: Date
  modifiedAt: Date
  deletedAt?: Date
}
```

---

## 6. Encrypted Item

Structure of encrypted content stored in R2.

### TypeScript Type

```typescript
interface EncryptedItem {
  id: string                      // Item UUID
  type: 'note' | 'task' | 'project' | 'settings'

  // Encrypted content
  encryptedKey: string            // File key encrypted with Vault Key (Base64)
  keyNonce: string                // Nonce for key encryption (Base64)
  encryptedData: string           // Content encrypted with File Key (Base64)
  dataNonce: string               // Nonce for data encryption (Base64)

  // Integrity
  signature: string               // Ed25519 signature (Base64)

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
  signature: string

  // Incremental updates
  updates: EncryptedUpdate[]
}

interface EncryptedUpdate {
  encryptedData: string           // Yjs update (Base64)
  nonce: string
  timestamp: number
  signature: string
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

interface ChunkRef {
  index: number                   // Position in file (0-based)
  hash: string                    // SHA-256 of plaintext chunk
  encryptedHash: string           // SHA-256 of encrypted chunk (for R2 lookup)
  size: number                    // Actual chunk size
}
```

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
  SERVER_CLOCK: 'server_clock',           // Last known server timestamp
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

## 10. Vector Clock

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
| Attachment | Client files + R2 | Yes | Chunked |
| Sync State | Client SQLite | No | Local only |
| Sync History | Client SQLite | No | Local only |
