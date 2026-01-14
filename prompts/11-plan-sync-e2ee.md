# Sync Engine & E2EE Implementation Plan

Technical architecture, technology decisions, and implementation strategy for cross-device sync with end-to-end encryption.

```
/speckit.plan @specs/001-sync-e2ee/spec.md

Plan the implementation of Memry's Sync Engine and End-to-End Encryption system with these technology decisions and constraints:

## REFERENCE DOCUMENTS

- **Specification**: specs/001-sync-e2ee/spec.md (18 user stories, 70 functional requirements)
- **Technical Design**: prompts/06-specify-sync.md (detailed cryptographic design, code patterns)
- **Constitution**: prompts/00-constitution.md (governing principles)
- **Existing Architecture**: CLAUDE.md (current codebase patterns)

## EXISTING CODEBASE (Must Integrate With)

### Electron Architecture
- **Main Process**: Node.js environment for native APIs, IPC handlers, file system
- **Preload Script**: Secure bridge via `window.api` and `window.electron`
- **Renderer Process**: React 19 app, no direct Node.js access
- **IPC Pattern**: `ipcMain.handle` + `ipcRenderer.invoke` with Zod validation

### Database Layer (Drizzle ORM + better-sqlite3)
- **data.db**: Source of truth for tasks, projects, statuses, settings
- **index.db**: Rebuildable cache for notes, FTS search
- **Schemas**: `src/shared/db/schema/data-schema.ts`, `index-schema.ts`
- **Client**: `src/main/database/client.ts` with optimized SQLite pragmas

### State Management
- React Context providers (TabProvider, TasksProvider, DragProvider)
- No Redux/Zustand - keep consistent with existing patterns
- Services in `src/renderer/src/services/`
- Custom hooks in `src/renderer/src/hooks/`

### File Structure Conventions
```
src/main/
├── ipc/           # IPC handlers (sync-handlers.ts, etc.)
├── database/      # Drizzle client, migrations
├── vault/         # File operations, watcher
└── lib/           # Utilities (errors.ts, paths.ts, id.ts)

src/renderer/src/
├── contexts/      # React contexts (sync-context.tsx)
├── hooks/         # Custom hooks (use-sync.ts)
├── services/      # API services (sync-service.ts)
└── components/    # UI components
```

## TECHNOLOGY STACK DECISIONS

### Cryptography Libraries

**Primary: libsodium-wrappers (sodium-native for Node.js)**
- XChaCha20-Poly1305 for content encryption (24-byte nonces, safe for high message counts)
- Ed25519 for signatures (authenticity verification)
- X25519 for ECDH key exchange (device linking)
- Argon2id for key derivation (OWASP parameters: 64MB, 3 iterations, parallelism 4)

**Key Management: keytar**
- Cross-platform OS keychain access
- macOS: Keychain, Windows: Credential Manager, Linux: libsecret
- Store master key, device keys in keychain
- NEVER store recovery phrase

**Recovery Phrase: bip39**
- 24-word BIP39 mnemonic (256 bits entropy)
- Standard word list, familiar to crypto users
- `mnemonicToSeed()` for deterministic key derivation

### CRDT Library (for Notes)

**Choice: Yjs**
- Mature, well-tested CRDT implementation
- Built-in BlockNote integration (our rich text editor)
- Efficient binary encoding for sync
- Awareness protocol for real-time presence (future collaboration)
- y-indexeddb for local persistence

**Integration Pattern:**
```typescript
// Note document structure
interface NoteYjsDocument {
  id: string
  doc: Y.Doc
  content: Y.XmlFragment      // BlockNote rich text
  meta: Y.Map<any>            // title, created, modified
  tags: Y.Array<string>       // Tags as CRDT array
  properties: Y.Map<any>      // Custom properties
}
```

### Sync Server Stack

**Choice: Hono.js on Cloudflare Workers**
- Edge deployment (low latency globally)
- Durable Objects for user sync state and real-time connections
- R2 for encrypted blob storage (S3-compatible, cost-effective)
- D1 for metadata (user accounts, device registry, sync items)
- WebSocket support via Durable Objects

**Why Not Alternatives:**
- Supabase: Less control over E2EE implementation
- Fastify/Railway: Higher cost, no edge benefits
- AWS Lambda: Cold start latency, complex WebSocket handling

### Client-Side Storage

**Sync Queue: IndexedDB (via idb)**
- Persist sync queue across app restarts
- Store encrypted items pending upload
- Track sync state and vector clocks

**Yjs Persistence: y-indexeddb**
- Local persistence for Yjs documents
- Works offline, syncs when connected

**Attachment Cache: File System**
- Store downloaded attachments in `vault/.memry/attachments/`
- Chunk-based storage matching server structure

## ARCHITECTURE CONSTRAINTS

### Security Requirements (Non-Negotiable)

1. **Zero-Knowledge Server**
   - Server stores ONLY encrypted blobs
   - Server cannot read: content, filenames, tags, structure
   - Server sees only: user ID, blob sizes, timestamps, item IDs

2. **Key Hierarchy**
   ```
   Recovery Phrase (24 words)
       → [Argon2id + Salt]
       → Master Key (256-bit)
           → Vault Key (HKDF derive, encrypt file keys)
           → Signing Key (HKDF derive, sign encrypted items)
           → Device Keys (HKDF per device, server auth)
   ```

3. **Content Signing**
   - All encrypted items MUST be signed with Ed25519
   - Reject items with invalid signatures (prevent tampering)
   - Signature covers: id + encryptedData + nonce

4. **Nonce Safety**
   - XChaCha20 uses 24-byte nonces (safe for random generation)
   - NEVER reuse nonces with same key
   - Store both keyNonce (for file key) and dataNonce (for content)

### Performance Targets (from spec)

| Operation | Target | Notes |
|-----------|--------|-------|
| Single item sync | < 2 seconds | On standard broadband |
| Batch sync (100 items) | < 30 seconds | Parallel where possible |
| Initial sync (1000 items) | < 5 minutes | New device setup |
| Note edit to synced | < 500ms | Via WebSocket push |
| UI during sync | Never blocked | Background workers |
| 10,000+ items | No degradation | Pagination, virtualization |

### Reliability Requirements

1. **Offline-First**
   - All features work without internet
   - Changes queue locally, sync when online
   - Network failures never cause data loss

2. **Sync Queue Persistence**
   - Queue survives app crashes
   - Queue survives system restarts
   - Exponential backoff on failures (max 60s)

3. **Conflict-Free Merging**
   - Notes: Yjs CRDTs (automatic merge, no conflicts)
   - Tasks: Vector clocks + field-level LWW
   - Settings: Last-writer-wins at field level

## INTEGRATION REQUIREMENTS

### With Existing Notes System

The notes system already uses BlockNote for rich text editing. Integration points:

1. **ContentArea.tsx**: Add Yjs collaboration provider
2. **notes-handlers.ts**: Add sync-aware CRUD operations
3. **Note file operations**: Encrypt before sync, decrypt after pull

```typescript
// Integration with existing BlockNote editor
const editor = BlockNoteEditor.create({
  collaboration: {
    fragment: noteDoc.content,
    provider: createMemrySyncProvider(noteId)
  }
})
```

### With Existing Task System

Tasks use SQLite (data.db) with Drizzle ORM. Integration points:

1. **tasks-handlers.ts**: Add vector clock to mutations
2. **TasksProvider**: Subscribe to sync updates
3. **Sync layer**: Encrypt task JSON, track field-level clocks

### With Existing Vault System

Vault manager handles file operations. Integration points:

1. **vault/index.ts**: Add sync initialization on vault open
2. **vault/watcher.ts**: Trigger sync on external file changes
3. **vault/notes.ts**: Encrypt before sync, maintain local .md files

## PHASED IMPLEMENTATION APPROACH

### Phase 1: Cryptography Foundation
- [ ] Implement key derivation (Argon2id + HKDF)
- [ ] Recovery phrase generation and validation
- [ ] Keychain integration (keytar)
- [ ] Content encryption/decryption utilities
- [ ] Signature generation and verification
- [ ] Unit tests for all crypto operations

### Phase 2: First Device Setup
- [ ] OAuth flow (Google, Apple, GitHub)
- [ ] Recovery phrase display and confirmation UI
- [ ] Master key generation and storage
- [ ] Device registration API
- [ ] Setup flow integration

### Phase 3: Sync Server Infrastructure
- [ ] Cloudflare Workers project setup
- [ ] D1 schema (users, devices, sync_items)
- [ ] R2 bucket configuration
- [ ] Auth endpoints (OAuth callbacks, JWT)
- [ ] Basic sync endpoints (push/pull)
- [ ] Durable Objects for user state

### Phase 4: Client Sync Engine
- [ ] IndexedDB sync queue
- [ ] Sync engine class (push, pull, connect)
- [ ] WebSocket connection management
- [ ] Network status monitoring
- [ ] Retry logic with exponential backoff

### Phase 5: Note Sync (CRDT)
- [ ] Yjs integration with BlockNote
- [ ] MemrySyncProvider implementation
- [ ] Encrypted snapshot storage
- [ ] Incremental update sync
- [ ] Snapshot compaction

### Phase 6: Task/Settings Sync (Vector Clocks)
- [ ] Vector clock implementation
- [ ] Field-level merge logic
- [ ] Task sync handlers
- [ ] Settings sync handlers

### Phase 7: Device Linking
- [ ] QR code generation (ephemeral ECDH keys)
- [ ] QR code scanning and parsing
- [ ] Key exchange protocol
- [ ] Approval flow UI
- [ ] Recovery phrase restoration flow

### Phase 8: Binary Attachments
- [ ] Chunked upload implementation
- [ ] Content-addressable storage
- [ ] Deduplication checks
- [ ] Resumable uploads
- [ ] Streaming downloads
- [ ] Thumbnail generation

### Phase 9: Sync Status & History
- [ ] Sync status indicator component
- [ ] Activity history storage and UI
- [ ] Manual sync trigger
- [ ] Error display and retry UI

### Phase 10: Device Management
- [ ] Device list UI
- [ ] Device removal with access revocation
- [ ] Device info display (platform, last sync)

### Phase 11: Advanced Features (P3)
- [ ] Local-only content flag
- [ ] Selective sync (mobile)
- [ ] Data usage tracking
- [ ] Metered connection detection
- [ ] Key rotation

## DATABASE SCHEMA ADDITIONS

### data.db (Local - Drizzle)

```typescript
// New tables for sync state
export const syncState = sqliteTable('sync_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull()
})

export const syncQueue = sqliteTable('sync_queue', {
  id: text('id').primaryKey(),
  type: text('type').notNull(), // 'note_update' | 'task' | 'attachment'
  itemId: text('item_id').notNull(),
  payload: text('payload').notNull(), // Encrypted JSON
  attempts: integer('attempts').default(0),
  lastAttempt: integer('last_attempt', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull()
})

export const devices = sqliteTable('devices', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  platform: text('platform').notNull(),
  linkedAt: integer('linked_at', { mode: 'timestamp' }).notNull(),
  lastSyncAt: integer('last_sync_at', { mode: 'timestamp' }),
  isCurrentDevice: integer('is_current_device', { mode: 'boolean' }).default(false)
})

export const syncHistory = sqliteTable('sync_history', {
  id: text('id').primaryKey(),
  type: text('type').notNull(), // 'push' | 'pull' | 'error'
  itemCount: integer('item_count').notNull(),
  details: text('details'), // JSON for errors
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull()
})
```

### Server D1 Schema

```sql
-- Users (from OAuth)
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  auth_provider TEXT NOT NULL,
  encrypted_salt TEXT NOT NULL,
  verification_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  storage_used INTEGER DEFAULT 0,
  storage_limit INTEGER DEFAULT 5368709120 -- 5GB
);

-- Devices
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  public_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_sync_at INTEGER
);

-- Sync Items (metadata only)
CREATE TABLE sync_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  blob_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  state_vector TEXT, -- For CRDT items
  created_at INTEGER NOT NULL,
  modified_at INTEGER NOT NULL,
  deleted_at INTEGER
);

-- Device Linking Sessions
CREATE TABLE linking_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  initiator_device_id TEXT NOT NULL REFERENCES devices(id),
  ephemeral_public_key TEXT NOT NULL,
  new_device_public_key TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
```

## IPC HANDLERS TO ADD

```typescript
// src/main/ipc/sync-handlers.ts
export function registerSyncHandlers() {
  // Setup & Device Management
  ipcMain.handle('sync:setup-first-device', handleSetupFirstDevice)
  ipcMain.handle('sync:get-recovery-phrase', handleGetRecoveryPhrase)
  ipcMain.handle('sync:confirm-recovery-phrase', handleConfirmRecoveryPhrase)
  ipcMain.handle('sync:generate-linking-qr', handleGenerateLinkingQR)
  ipcMain.handle('sync:link-via-qr', handleLinkViaQR)
  ipcMain.handle('sync:link-via-recovery', handleLinkViaRecovery)
  ipcMain.handle('sync:approve-linking', handleApproveLinking)
  ipcMain.handle('sync:get-devices', handleGetDevices)
  ipcMain.handle('sync:remove-device', handleRemoveDevice)

  // Sync Operations
  ipcMain.handle('sync:get-status', handleGetSyncStatus)
  ipcMain.handle('sync:trigger-sync', handleTriggerSync)
  ipcMain.handle('sync:get-history', handleGetSyncHistory)
  ipcMain.handle('sync:get-queue-size', handleGetQueueSize)

  // Encryption
  ipcMain.handle('sync:encrypt-item', handleEncryptItem)
  ipcMain.handle('sync:decrypt-item', handleDecryptItem)

  // Attachments
  ipcMain.handle('sync:upload-attachment', handleUploadAttachment)
  ipcMain.handle('sync:download-attachment', handleDownloadAttachment)
  ipcMain.handle('sync:get-upload-progress', handleGetUploadProgress)
}
```

## TESTING STRATEGY

### Unit Tests (Vitest)
- [ ] Key derivation produces consistent results
- [ ] Encryption roundtrip (encrypt → decrypt = original)
- [ ] Signature verification (valid sig passes, invalid fails)
- [ ] Vector clock comparison and merge
- [ ] Chunk splitting and reassembly

### Integration Tests
- [ ] Sync queue persistence across restart
- [ ] Note sync with Yjs merge
- [ ] Task sync with vector clock merge
- [ ] Device linking full flow (mock server)
- [ ] Attachment chunked upload/download

### E2E Tests (Playwright)
- [ ] First device setup flow
- [ ] Create note → sync → verify on second instance
- [ ] Offline edit → come online → sync
- [ ] Device linking via QR code
- [ ] Conflict scenario (edit same note on two devices)

### Security Tests
- [ ] Verify server receives only encrypted blobs
- [ ] Verify no plaintext in logs or network traffic
- [ ] Verify nonce uniqueness across encryptions
- [ ] Verify signature rejection on tampered data
- [ ] Verify recovery phrase restores access

## OPEN QUESTIONS FOR PLANNING

1. **Attachment storage limit per user**: 5GB default? Configurable?
2. **Sync conflict notification**: Silent merge or notify user?
3. **Real-time WebSocket**: Always connected or connect-on-demand?
4. **Selective sync on desktop**: Full sync only, or allow exclusions?
5. **Key rotation frequency**: Manual only or prompt periodically?

## SUCCESS METRICS

- [ ] All 18 user stories have passing acceptance tests
- [ ] All 70 functional requirements implemented
- [ ] All 22 success criteria measurable and verified
- [ ] Zero plaintext visible in server storage
- [ ] < 2 second single item sync latency
- [ ] Works fully offline after initial sync
```
