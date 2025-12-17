# Backend Implementation Plan

Technical architecture, tech stack decisions, and implementation strategy.

```
/speckit.plan

Plan the implementation of Memry's backend with these technology decisions:

## EXISTING FRONTEND STACK (Keep)
- Electron 28+ with electron-vite for build tooling
- React 19 with TypeScript 5.3+
- Tailwind CSS + shadcn/ui components
- @dnd-kit for drag-drop
- BlockNote for rich text editing (or TipTap)
- date-fns for date utilities

## LOCAL DATA LAYER

### SQLite Database
**Choice: better-sqlite3**
- Synchronous API (simpler, faster for most operations)
- Native binding (faster than WASM alternatives like sql.js)
- Runs in Electron main process
- Exposed to renderer via IPC

**Alternatives Considered:**
- sql.js: WASM-based, works in browser, but slower
- Prisma: ORM overhead, harder with Electron
- Drizzle: Good option if we want TypeScript ORM

**Database Files:**
vault/.memry/
├── index.db     # Note cache, FTS index (rebuildable)
└── data.db      # Tasks, projects, inbox, settings (source of truth)


### File System Operations
**Choice: Node.js fs/promises + chokidar**
- fs/promises for async file operations
- chokidar for reliable cross-platform file watching
- gray-matter for frontmatter parsing
- Runs in main process, IPC to renderer

**Alternatives Considered:**
- @parcel/watcher: Faster but less mature
- node-watch: Simpler but fewer features
- fs.watch native: Inconsistent across platforms

## ENCRYPTION LAYER

### Cryptography
**Choice: libsodium-wrappers**
- Well-audited, battle-tested library
- AES-256-GCM for content encryption
- Argon2id for key derivation
- XChaCha20-Poly1305 as alternative
- Works in both Node.js and browser

**Key Storage:**
**Choice: keytar**
- Cross-platform keychain access
- macOS: Keychain
- Windows: Credential Manager
- Linux: libsecret

**Recovery Phrase:**
**Choice: bip39**
- Standard mnemonic word list
- 24 words = 256 bits of entropy
- Well-understood by users from crypto

## SYNC SERVER (Backend API)

### Framework Decision

**Option A: Hono.js on Cloudflare Workers (Recommended)**
- Edge deployment (low latency globally)
- Generous free tier (100k requests/day)
- Durable Objects for real-time sync state
- R2 for blob storage (S3-compatible)
- D1 for SQLite at edge (user metadata)
- TypeScript native

**Option B: Fastify on Railway/Fly.io**
- More traditional Node.js
- Full control over infrastructure
- WebSocket support built-in
- PostgreSQL (Neon/Supabase)
- S3/R2 for blob storage
- Higher cost at scale

**Option C: Supabase (All-in-One)**
- Managed PostgreSQL
- Built-in Auth (OAuth providers)
- Realtime subscriptions
- Edge Functions for custom logic
- Storage for blobs
- Fast to start, less control

**Recommendation: Start with Option A (Hono + Cloudflare)**
- Best cost-to-performance ratio
- Edge latency benefits
- Scale to zero (no cost when not used)
- Can migrate to Option B if needed

### Server Architecture
┌─────────────────────────────────────────────────────────────┐
│                    Cloudflare Workers                        │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ Auth Worker  │  │ Sync Worker  │  │ Blob Worker  │      │
│  │              │  │              │  │              │      │
│  │ OAuth flow   │  │ Push/Pull    │  │ Upload/      │      │
│  │ JWT tokens   │  │ Versions     │  │ Download     │      │
│  │ Devices      │  │ Conflicts    │  │ Streaming    │      │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘      │
│         │                 │                 │               │
│  ┌──────▼─────────────────▼─────────────────▼───────┐      │
│  │                   Durable Objects                 │      │
│  │            (User sync state, device registry)     │      │
│  └──────────────────────────────────────────────────┘      │
│                                                              │
│  ┌──────────────────────┐  ┌───────────────────────┐       │
│  │         D1           │  │          R2           │       │
│  │   (User metadata)    │  │  (Encrypted blobs)    │       │
│  └──────────────────────┘  └───────────────────────┘       │
│                                                              │
└─────────────────────────────────────────────────────────────┘

### Database Schema (D1)
```sql
-- Users (from OAuth)
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  auth_provider TEXT NOT NULL,  -- 'google' | 'apple' | 'github'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  storage_used INTEGER DEFAULT 0,
  storage_limit INTEGER DEFAULT 1073741824  -- 1GB
);

-- Devices
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  public_key TEXT NOT NULL,  -- For device auth
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_sync_at DATETIME
);

-- Sync Items (metadata only, content in R2)
CREATE TABLE sync_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,  -- 'note' | 'task' | 'journal' | 'inbox' | 'attachment'
  version INTEGER NOT NULL DEFAULT 1,
  size INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  modified_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  deleted_at DATETIME  -- Soft delete
);

-- Sync conflicts (for review)
CREATE TABLE conflicts (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES sync_items(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  version INTEGER NOT NULL,
  blob_key TEXT NOT NULL,  -- R2 key for conflict version
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### API Endpoints
```typescript
// Auth
POST   /auth/oauth/google        // OAuth callback
POST   /auth/oauth/apple
POST   /auth/oauth/github
POST   /auth/refresh             // Refresh JWT
POST   /auth/device/link         // Link new device
DELETE /auth/device/:id          // Remove device

// Sync
GET    /sync/status              // Get sync state
GET    /sync/changes?since=      // Get changed items since version
POST   /sync/push                // Push local changes
POST   /sync/pull                // Request specific items

// Blobs
PUT    /blob/:id                 // Upload encrypted blob
GET    /blob/:id                 // Download encrypted blob
DELETE /blob/:id                 // Delete blob

// User
GET    /user/profile             // Get user info
GET    /user/storage             // Get storage usage
GET    /user/devices             // List devices
```

## MOBILE APP (Future Phase)

### Framework
**Choice: React Native with Expo**
- Share business logic with desktop
- Expo for easier development
- expo-sqlite for local database
- Same encryption library (libsodium has RN bindings)

### Considerations
- Selective sync (don't download all attachments)
- Background sync (iOS/Android limitations)
- Push notifications for real-time updates
- Share sheet integration for quick capture

## AI FEATURES

### Embeddings & Semantic Search
**Choice: OpenAI text-embedding-3-small (default) + Ollama (local option)**
- OpenAI: Best quality, reasonable cost
- Ollama: Local, private, works offline
- Store embeddings in SQLite with vec extension (or separate vector DB)

**Alternative: Use Supabase pgvector if using Supabase**

### LLM for Completions
**Choice: OpenAI GPT-4-turbo (default) + Ollama local models (optional)**
- OpenAI: Best quality for writing assistance
- Ollama: Llama 3, Mistral for local option
- Anthropic Claude as secondary option

## IMPLEMENTATION ORDER

### Phase 1: Core Data Layer (Week 1-2)
1. Set up better-sqlite3 in main process
2. Create database schemas (index.db, data.db)
3. Implement IPC handlers for CRUD operations
4. Set up chokidar file watcher
5. Implement rename detection algorithm
6. Connect existing UI to real data layer

### Phase 2: Task Backend (Week 3-4)
1. Task CRUD with SQLite
2. Project and status management
3. Repeating task logic
4. Subtask relationships
5. Connect TasksPage to real data

### Phase 3: Notes & Journal Backend (Week 5-6)
1. Note file operations (create, read, write, delete)
2. Frontmatter parsing and generation
3. Wiki link extraction and backlink computation
4. Journal date-based file management
5. Connect NotePage and JournalPage to real data

### Phase 4: Encryption Layer (Week 7-8)
1. Implement key generation and derivation
2. Recovery phrase generation
3. Keychain integration
4. Content encryption/decryption
5. Test encryption thoroughly

### Phase 5: Sync Server (Week 9-11)
1. Set up Cloudflare Workers project
2. Implement OAuth flows
3. Create sync endpoints
4. Implement push/pull logic
5. Blob storage with R2

### Phase 6: Sync Client (Week 12-14)
1. Sync queue implementation
2. Background sync worker
3. Conflict detection and resolution
4. Device linking (QR code)
5. Sync status UI

### Phase 7: Inbox Backend (Week 15-16)
1. Inbox item storage
2. Link fetching (URL metadata)
3. Voice recording and storage
4. Transcription integration
5. Filing operations

### Phase 8: Search & AI (Week 17-19)
1. FTS5 search implementation
2. Embedding generation pipeline
3. Semantic search
4. AI chat interface
5. Writing assistance commands

### Phase 9: Settings & Polish (Week 20-21)
1. Settings persistence
2. Preferences UI
3. Data export/import
4. Error handling polish
5. Performance optimization

### Phase 10: Mobile App (Week 22+)
1. React Native project setup
2. Share core logic
3. Implement mobile UI
4. Mobile-specific features
5. App store submission

## RESEARCH QUESTIONS

### To Investigate Further
1. **SQLite in Electron**: Verify better-sqlite3 works reliably with electron-vite
2. **File watching**: Benchmark chokidar vs @parcel/watcher for large vaults
3. **Sync protocol**: Evaluate CRDTs vs operational transform vs simple last-write-wins
4. **Voice transcription**: Compare Whisper API cost vs local whisper.cpp quality
5. **Vector storage**: SQLite vec extension vs dedicated vector DB vs simple linear search

### Deferred Decisions
1. Real-time collaboration (v2 feature)
2. Team/shared vaults (v2 feature)
3. Plugin system (v2 feature)
4. Web app version (v2 feature)

## TESTING STRATEGY

### Unit Tests
- Jest for utility functions
- Test encryption roundtrip
- Test date calculations
- Test conflict resolution logic

### Integration Tests
- Database operations
- File watcher events
- IPC communication
- Sync push/pull

### E2E Tests
- Playwright for Electron
- Critical user flows
- Sync between simulated devices

### Security Tests
- Verify no plaintext in transit
- Verify no plaintext in logs
- Verify key derivation consistency
- Verify recovery phrase restoration
```
