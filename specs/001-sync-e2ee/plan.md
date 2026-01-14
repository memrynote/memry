# Implementation Plan: Sync Engine & End-to-End Encryption

**Branch**: `001-sync-e2ee` | **Date**: 2026-01-14 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-sync-e2ee/spec.md`

## Summary

Implement a comprehensive sync engine with end-to-end encryption (E2EE) for Memry's cross-device synchronization. The system uses CRDTs (Yjs) for conflict-free note merging, vector clocks for structured data (tasks), and a zero-knowledge server architecture where all content is encrypted client-side before transmission. Key features include OAuth-based authentication, BIP39 recovery phrases, QR code device linking, chunked binary attachment sync, and comprehensive sync status visibility.

## Technical Context

**Language/Version**: TypeScript 5.3+ (strict mode), Node.js 20+
**Primary Dependencies**:
- Electron 28+ with electron-vite (existing)
- React 19 (existing)
- Drizzle ORM + better-sqlite3 (existing)
- libsodium-wrappers / sodium-native (crypto)
- keytar (OS keychain)
- bip39 (recovery phrases)
- Yjs + y-indexeddb (CRDTs)
- Hono.js (sync server on Cloudflare Workers)

**Storage**:
- Client: SQLite (data.db for tasks, index.db for notes cache) + IndexedDB (sync queue, Yjs persistence)
- Server: Cloudflare D1 (metadata) + R2 (encrypted blobs)

**Testing**: Vitest (unit), Playwright (E2E)
**Target Platform**: Electron (macOS, Windows, Linux), future mobile (iOS, Android)
**Project Type**: Electron desktop app + Cloudflare Workers API

**Performance Goals**:
- Single item sync: < 2 seconds
- Batch sync (100 items): < 30 seconds
- Initial sync (1000 items): < 5 minutes
- Note edit to synced: < 500ms
- 10,000+ items without degradation

**Constraints**:
- Zero-knowledge server (only encrypted blobs)
- Offline-first (full functionality without internet)
- UI never blocked during sync
- All content signed (Ed25519)
- XChaCha20-Poly1305 encryption (24-byte nonces)

**Scale/Scope**:
- 5GB storage per user
- Up to 10,000 items per vault
- Up to 10 linked devices per account
- Attachments up to 500MB

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| **Local-First Architecture** | PASS | Data lives on device, sync is enhancement not requirement |
| **End-to-End Encryption** | PASS | Zero-knowledge server, client-side encryption |
| **No Vendor Lock-In** | PASS | Notes remain .md files, tasks exportable |
| **Privacy by Design** | PASS | Minimal metadata exposure, no telemetry |
| **Offline-First** | PASS | All features work without internet |
| **File System as Source of Truth** | PASS | .md files authoritative, encrypted for sync |
| **Database for Structured Data** | PASS | Tasks/projects in SQLite, synced as encrypted blob |
| **Type Safety** | PASS | Full TypeScript strict mode, Zod validation |
| **Performance** | PASS | Targets defined and measurable |
| **Encryption Standards** | PASS | XChaCha20-Poly1305, Argon2id, Ed25519 |
| **Key Management** | PASS | Keychain storage, BIP39 recovery |
| **Secure Communication** | PASS | TLS 1.3, certificate pinning planned |

**Gate Status**: PASS - All principles satisfied

## Project Structure

### Documentation (this feature)

```text
specs/001-sync-e2ee/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output (API contracts)
│   ├── auth.yaml        # OAuth and device auth endpoints
│   ├── sync.yaml        # Sync push/pull endpoints
│   ├── blob.yaml        # Attachment upload/download
│   └── ipc.yaml         # Electron IPC contracts
└── tasks.md             # Phase 2 output (speckit.tasks)
```

### Source Code (repository root)

```text
# Electron App (existing structure, additions marked with +)

src/main/
├── ipc/
│   ├── index.ts              # Handler registration
│   ├── validate.ts           # Zod validation middleware
│   ├── vault-handlers.ts     # Existing
│   ├── notes-handlers.ts     # Existing
│   ├── tasks-handlers.ts     # Existing (+ vector clock)
│   ├── + sync-handlers.ts    # NEW: Sync operations
│   └── + crypto-handlers.ts  # NEW: Encryption operations
├── database/
│   ├── client.ts             # Existing Drizzle client
│   ├── migrate.ts            # Existing
│   └── + sync-schema.ts      # NEW: Sync-related tables
├── vault/
│   ├── index.ts              # Existing (+ sync init)
│   ├── watcher.ts            # Existing (+ sync triggers)
│   └── notes.ts              # Existing
├── + sync/                   # NEW: Sync engine module
│   ├── engine.ts             # Main sync engine class
│   ├── queue.ts              # Sync queue management
│   ├── websocket.ts          # WebSocket connection
│   ├── crdt-provider.ts      # Yjs sync provider
│   └── attachments.ts        # Chunked attachment sync
├── + crypto/                 # NEW: Cryptography module
│   ├── keys.ts               # Key derivation (Argon2id, HKDF)
│   ├── encryption.ts         # XChaCha20-Poly1305
│   ├── signatures.ts         # Ed25519 signing
│   ├── recovery.ts           # BIP39 recovery phrase
│   └── keychain.ts           # OS keychain integration
└── lib/
    ├── errors.ts             # Existing
    ├── paths.ts              # Existing
    └── id.ts                 # Existing

src/renderer/src/
├── contexts/
│   ├── tabs/                 # Existing
│   ├── tasks/                # Existing (+ sync subscription)
│   └── + sync-context.tsx    # NEW: Sync state provider
├── hooks/
│   ├── use-notes.ts          # Existing
│   └── + use-sync.ts         # NEW: Sync status hook
├── services/
│   └── + sync-service.ts     # NEW: Sync API service
├── components/
│   └── + sync/               # NEW: Sync UI components
│       ├── sync-status.tsx   # Status indicator
│       ├── sync-history.tsx  # Activity history
│       ├── device-list.tsx   # Device management
│       └── qr-linking.tsx    # QR code device linking
└── pages/
    └── + settings/           # Sync settings pages
        └── sync-settings.tsx

src/shared/
├── db/schema/
│   ├── data-schema.ts        # Existing (+ sync tables)
│   └── index-schema.ts       # Existing
└── + contracts/              # NEW: Shared type contracts
    ├── sync-api.ts           # Sync API types
    ├── crypto.ts             # Crypto types
    └── ipc-sync.ts           # IPC channel types

# Sync Server (new Cloudflare Workers project)

sync-server/
├── src/
│   ├── index.ts              # Hono app entry
│   ├── routes/
│   │   ├── auth.ts           # OAuth callbacks, JWT
│   │   ├── sync.ts           # Push/pull endpoints
│   │   ├── blob.ts           # R2 upload/download
│   │   └── devices.ts        # Device management
│   ├── middleware/
│   │   ├── auth.ts           # JWT validation
│   │   └── rate-limit.ts     # Rate limiting
│   ├── services/
│   │   ├── user.ts           # User operations
│   │   ├── device.ts         # Device operations
│   │   └── sync.ts           # Sync state
│   └── durable-objects/
│       ├── user-state.ts     # Per-user sync state
│       └── linking-session.ts # Device linking sessions
├── schema/
│   └── d1.sql                # D1 database schema
├── wrangler.toml             # Cloudflare config
└── tests/
    └── *.test.ts

tests/
├── unit/
│   ├── crypto/               # Crypto function tests
│   └── sync/                 # Sync logic tests
├── integration/
│   ├── sync-queue.test.ts
│   └── device-linking.test.ts
└── e2e/
    ├── setup-flow.test.ts
    ├── sync-flow.test.ts
    └── offline-sync.test.ts
```

**Structure Decision**: Electron app with embedded sync module + separate Cloudflare Workers server. The existing Electron architecture is preserved with new modules added for sync and crypto. Server is a standalone Hono.js project deployed to Cloudflare Workers.

## Complexity Tracking

| Component | Complexity | Justification |
|-----------|------------|---------------|
| Separate sync-server project | Moderate | Required for edge deployment, WebSocket support via Durable Objects |
| Multiple crypto algorithms | Moderate | XChaCha20 (encryption), Ed25519 (signing), X25519 (key exchange), Argon2id (KDF) - all industry standard |
| CRDT + Vector Clock hybrid | Moderate | Notes need CRDTs for rich text merge, tasks need simpler LWW - different data models |
| IndexedDB + SQLite dual storage | Low | IndexedDB for browser-context data (sync queue), SQLite for persistent data - existing pattern |

## Implementation Phases

### Phase 1: Cryptography Foundation
- Key derivation (Argon2id + HKDF)
- Recovery phrase generation (BIP39)
- Keychain integration (keytar)
- XChaCha20-Poly1305 encryption
- Ed25519 signatures
- Unit tests for all crypto

### Phase 2: First Device Setup
- Email/password signup with verification
- OAuth flow integration (Google, Apple, GitHub)
- Password validation (min 12 chars, complexity)
- Recovery phrase UI
- Master key generation and storage
- Device registration

### Phase 3: Sync Server Infrastructure
- Cloudflare Workers setup
- D1 schema
- R2 configuration
- Auth endpoints
- Basic sync endpoints

### Phase 4: Client Sync Engine
- IndexedDB sync queue
- Sync engine class
- WebSocket connection
- Network monitoring
- Retry logic

### Phase 5: Note Sync (CRDT)
- Yjs integration
- Encrypted sync provider
- Snapshot compaction

### Phase 6: Task/Settings Sync
- Vector clock implementation
- Field-level merge
- Task sync handlers

### Phase 7: Device Linking
- QR code generation
- ECDH key exchange
- Approval flow

### Phase 8: Binary Attachments
- Chunked upload/download
- Deduplication
- Resumable uploads

### Phase 9: Sync Status & History
- Status indicator
- Activity history
- Manual sync

### Phase 10: Device Management
- Device list
- Device removal

### Phase 11: Advanced Features (P3)
- Local-only content
- Selective sync
- Data usage
- Key rotation
