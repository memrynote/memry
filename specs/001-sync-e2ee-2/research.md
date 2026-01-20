# Research: Sync Engine & E2EE

**Feature**: 001-sync-e2ee-2 | **Date**: 2026-01-14

This document captures research findings and decisions for implementing the sync engine and end-to-end encryption system.

## Table of Contents

1. [Cryptography Library Selection](#1-cryptography-library-selection)
2. [Key Derivation Parameters](#2-key-derivation-parameters)
3. [CRDT Library for Notes](#3-crdt-library-for-notes)
4. [Sync Server Architecture](#4-sync-server-architecture)
5. [Passwordless Email Authentication (OTP)](#5-passwordless-email-authentication-otp)
6. [OAuth Provider Integration](#6-oauth-provider-integration)
7. [QR Code Device Linking Protocol](#7-qr-code-device-linking-protocol)
8. [Chunked Attachment Storage](#8-chunked-attachment-storage)
9. [WebSocket vs Polling for Real-time Sync](#9-websocket-vs-polling-for-real-time-sync)
10. [Vector Clock Implementation](#10-vector-clock-implementation)
11. [Offline Queue Persistence](#11-offline-queue-persistence)

---

## 1. Cryptography Library Selection

### Decision: libsodium-wrappers + sodium-native

### Rationale

libsodium is the most widely recommended cryptography library for JavaScript applications:
- **Audited**: Professional security audit by independent researchers
- **Misuse-resistant**: Designed to make secure usage easy and insecure usage difficult
- **Cross-platform**: Works in Node.js (sodium-native) and browser (libsodium-wrappers)
- **Complete**: Includes all needed primitives (encryption, signatures, key exchange, KDF)

### Alternatives Considered

| Library | Pros | Cons | Decision |
|---------|------|------|----------|
| **Web Crypto API** | Native, fast, no dependencies | Missing Argon2id, XChaCha20; limited API | Rejected - missing critical primitives |
| **tweetnacl** | Small, pure JS | No Argon2id, no XChaCha20 | Rejected - missing primitives |
| **noble/crypto** | Modern, TypeScript | Newer, less battle-tested | Considered but libsodium preferred |
| **crypto-js** | Popular | Not suitable for security-critical code | Rejected - known vulnerabilities |

### Implementation Notes

```typescript
// Main process (Node.js) - use sodium-native for speed
import sodium from 'sodium-native'

// Renderer process (Electron) - use libsodium-wrappers
import _sodium from 'libsodium-wrappers'
await _sodium.ready
const sodium = _sodium

// Shared interface for both environments
interface CryptoService {
  encrypt(plaintext: Uint8Array, key: Uint8Array): Promise<{ ciphertext: Uint8Array, nonce: Uint8Array }>
  decrypt(ciphertext: Uint8Array, nonce: Uint8Array, key: Uint8Array): Promise<Uint8Array>
  sign(message: Uint8Array, secretKey: Uint8Array): Promise<Uint8Array>
  verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): Promise<boolean>
}
```

---

## 2. Key Derivation Parameters

### Decision: Argon2id with OWASP 2024 parameters

### Rationale

OWASP recommends these parameters for Argon2id:
- **Memory**: 64 MB (65536 KB)
- **Iterations**: 3
- **Parallelism**: 4
- **Hash length**: 32 bytes (256 bits)

These parameters provide strong protection against GPU/ASIC attacks while remaining practical on consumer hardware (~500ms derivation time).

### Alternatives Considered

| Parameters | Memory | Time | Security | Decision |
|------------|--------|------|----------|----------|
| OWASP minimum (19 MB, 2 iter) | Low | ~100ms | Good | Rejected - prefer higher security |
| OWASP recommended (64 MB, 3 iter) | Medium | ~500ms | Excellent | **Selected** |
| High security (1 GB, 10 iter) | High | ~5s | Maximum | Rejected - too slow for UX |

### Implementation Notes

```typescript
const ARGON2_PARAMS = {
  memoryCost: 65536,      // 64 MB
  timeCost: 3,            // 3 iterations
  parallelism: 4,         // 4 lanes
  hashLength: 32,         // 256-bit output
  type: argon2id          // Hybrid mode (best for password hashing)
}

// Salt must be random, stored encrypted on server
const salt = sodium.randombytes_buf(32)
```

---

## 3. CRDT Library for Notes

### Decision: Yjs with y-leveldb

### Rationale

Yjs is the industry standard for collaborative text editing:
- **BlockNote integration**: Official collaboration support via `@blocknote/core`
- **Mature**: 5+ years of production use, well-documented
- **Efficient**: Binary encoding minimizes sync payload size
- **Awareness protocol**: Built-in support for cursors/presence (future collaboration)
- **Persistence**: y-leveldb for main-process local persistence

### Alternatives Considered

| Library | Pros | Cons | Decision |
|---------|------|------|----------|
| **Yjs** | Mature, BlockNote native, awareness | Larger bundle | **Selected** |
| **Automerge** | Good for JSON, Rust core | No BlockNote integration | Rejected |
| **Fluid Framework** | Microsoft backed | Complex, server-dependent | Rejected |
| **ShareDB (OT)** | Simple | Not conflict-free, requires server | Rejected |

### Implementation Notes

```typescript
import * as Y from 'yjs'
import { LeveldbPersistence } from 'y-leveldb'

// Each note is a separate Yjs document
function createNoteDocument(noteId: string): Y.Doc {
  const doc = new Y.Doc({ guid: noteId })

  // Persist locally
  const persistence = new LeveldbPersistence(`memry-note-${noteId}`, doc)

  return doc
}

// Structure within each note document
const content = doc.getXmlFragment('content')     // BlockNote rich text
const meta = doc.getMap('meta')                   // { title, created, modified }
const tags = doc.getArray('tags')                 // ['tag1', 'tag2']
const properties = doc.getMap('properties')       // Custom properties
```

---

## 4. Sync Server Architecture

### Decision: Hono.js on Cloudflare Workers with Durable Objects

### Rationale

Cloudflare Workers provides the best combination of:
- **Edge latency**: Code runs close to users globally (~50ms vs ~200ms for centralized)
- **WebSocket support**: Durable Objects maintain persistent connections
- **Cost efficiency**: Pay per request, generous free tier (100k req/day)
- **Zero-knowledge compatible**: We control all code, no managed services accessing data

### Alternatives Considered

| Stack | Pros | Cons | Decision |
|-------|------|------|----------|
| **Cloudflare Workers** | Edge, WebSocket via DO, cheap | Learning curve | **Selected** |
| **Supabase** | Fast setup, realtime built-in | Less E2EE control | Rejected |
| **Fastify + Railway** | Familiar Node.js | No edge, higher cost | Backup option |
| **AWS Lambda + API Gateway** | Scalable | Cold starts, complex WebSocket | Rejected |

### Architecture Details

```
┌─────────────────────────────────────────────────────────────┐
│                    Cloudflare Workers Edge                   │
├─────────────────────────────────────────────────────────────┤
│  Hono.js Router                                              │
│  ├── /auth/*     → OAuth flows, JWT issuance                │
│  ├── /sync/*     → Push/pull encrypted items                │
│  ├── /blob/*     → R2 upload/download                       │
│  └── /devices/*  → Device management                        │
├─────────────────────────────────────────────────────────────┤
│  Durable Objects (stateful)                                  │
│  ├── UserSyncState  → Per-user sync coordination            │
│  └── LinkingSession → Device linking state                  │
├─────────────────────────────────────────────────────────────┤
│  D1 Database          │  R2 Object Storage                   │
│  - users              │  - Encrypted blobs                   │
│  - devices            │  - Attachment chunks                 │
│  - sync_items         │                                      │
│  - linking_sessions   │                                      │
└─────────────────────────────────────────────────────────────┘
```

---

## 5. Passwordless Email Authentication (OTP)

### Decision: 6-digit OTP codes via email

### Rationale

Passwordless authentication simplifies the user experience and reduces security risks:
- **No passwords to remember**: Users already have a 24-word recovery phrase for E2EE - adding another password doubles cognitive load
- **Server auth ≠ data security**: With E2EE, server authentication just gates sync access. All data remains encrypted.
- **Simpler implementation**: Eliminates password hashing, reset flows, and complexity rules
- **OAuth fallback**: Users who want "no email every time" can use Google/Apple/GitHub

### OTP Configuration

```typescript
const OTP_CONFIG = {
  codeLength: 6,              // 6 digits (000000-999999)
  expirySeconds: 600,         // 10 minutes
  maxAttempts: 5,             // Max failed attempts per code
  rateLimitRequests: 3,       // Max OTP requests per window
  rateLimitWindowSeconds: 600, // 10 minute window
  resendCooldownSeconds: 60,  // Min wait before resend
}

function generateOtpCode(): string {
  // Cryptographically random 6-digit code
  const randomBytes = sodium.randombytes_buf(4)
  const randomInt = (randomBytes[0] << 24) | (randomBytes[1] << 16) |
                    (randomBytes[2] << 8) | randomBytes[3]
  const code = Math.abs(randomInt) % 1000000
  return code.toString().padStart(6, '0')
}

function hashOtpCode(code: string): string {
  // SHA-256 hash for storage (not plaintext)
  return sodium.crypto_hash_sha256(Buffer.from(code)).toString('base64')
}
```

### OTP Authentication Flow

```
User                        Server                      Email Service
─────                       ──────                      ─────────────
1. POST /auth/email/request-otp
   { email }
                    ──────────────────────────>
                    2. Check rate limit (3/10min)
                    3. Generate 6-digit OTP
                    4. Hash and store OTP
                    5. Create user if new (email_verified=false)
                    6. Send OTP email
                    ───────────────────────────────────>
                    <───────────────────────────────────
                    7. Return { success, expires_in: 600 }
<──────────────────────────────
8. User receives email with code
9. POST /auth/email/verify-otp
   { email, code: "123456" }
                    ──────────────────────────>
                    10. Validate OTP hash
                    11. Check attempts < 5
                    12. Check not expired
                    13. Mark OTP as used
                    14. Set email_verified=true
                    15. Issue JWT tokens
<──────────────────────────────
```

### Security Measures

- **Rate limiting**: Max 3 OTP requests per 10 minutes per email
- **Attempt limiting**: Max 5 failed attempts per code, then invalidate
- **Code expiry**: 10 minutes from generation
- **Hash storage**: SHA-256 of code (never plaintext)
- **No user enumeration**: Always return 200 on request-otp to prevent email discovery
- **Brute force protection**: 6 digits = 1 million combinations, 5 attempts = 0.0005% chance

### UX Considerations

- **Auto-paste detection**: Client listens for OTP in clipboard
- **Resend cooldown**: 60 seconds before allowing resend
- **Countdown timer**: Show expiry countdown in UI
- **6-digit input**: Individual boxes for each digit with auto-advance

---

## 6. OAuth Provider Integration

### Decision: Google, Apple, GitHub via Cloudflare Workers

### Rationale

These three providers cover the vast majority of users:
- **Google**: Most common, well-documented OAuth 2.0
- **Apple**: Required for iOS App Store, Sign in with Apple
- **GitHub**: Popular among developers (target audience)

### Implementation Approach

```typescript
// Hono.js OAuth routes
app.get('/auth/google/callback', handleGoogleCallback)
app.get('/auth/apple/callback', handleAppleCallback)
app.get('/auth/github/callback', handleGitHubCallback)

// Common flow:
// 1. Client opens OAuth provider URL with state parameter
// 2. User authenticates with provider
// 3. Provider redirects to our callback with code
// 4. We exchange code for tokens
// 5. Extract user ID/email from provider
// 6. Create/update user in D1
// 7. Issue our own JWT for API auth
// 8. Redirect back to app with JWT
```

### Security Notes

- State parameter prevents CSRF
- PKCE (code_verifier/code_challenge) for additional security
- Short-lived access tokens (15 min), refresh tokens stored encrypted
- Email verified flag checked for all providers

---

## 7. QR Code Device Linking Protocol

### Decision: X25519 ECDH with 5-minute expiring sessions

### Rationale

QR code linking provides secure key transfer without typing recovery phrase:
- **X25519**: Fast, secure elliptic curve Diffie-Hellman
- **Ephemeral keys**: New keypair per linking session
- **Server-mediated**: Server facilitates but cannot decrypt

### Protocol Flow

```
EXISTING DEVICE                     SERVER                      NEW DEVICE
─────────────────                   ──────                      ──────────
1. Generate ephemeral X25519 keypair
2. Request linking session
   ──────────────────────────────>
3. Store session, return token
   <──────────────────────────────
4. Display QR: { pub, token, exp }
                                                               5. Scan QR code
                                                               6. Generate own keypair
                                                               7. Send: { token, newPub }
                                    <──────────────────────────
                                    8. Store newPub, notify existing
   <──────────────────────────────
9. User approves on existing device
10. Compute shared secret: ECDH(existingPriv, newPub)
11. Encrypt master key with shared secret
12. Send encrypted key via server
    ──────────────────────────────>
                                    13. Forward to new device
                                    ────────────────────────────>
                                                               14. Compute shared secret
                                                               15. Decrypt master key
                                                               16. Store in keychain
                                                               17. Begin sync
```

### Security Measures

- Sessions expire after 5 minutes
- One-time use tokens
- Server never sees shared secret or master key
- Approval required from existing device

---

## 8. Chunked Attachment Storage

### Decision: 8MB chunks with content-addressable storage

### Rationale

- **8MB chunks**: Balance between parallelism and overhead
- **Content-addressable**: SHA-256 hash as chunk ID enables deduplication
- **Resumable**: Failed uploads resume from last successful chunk

### Storage Format

```typescript
interface AttachmentManifest {
  id: string                    // Unique attachment ID
  filename: string              // Original filename (encrypted in manifest)
  mimeType: string              // File type
  size: number                  // Total size in bytes
  checksum: string              // SHA-256 of original file
  chunks: ChunkRef[]            // Ordered list of chunks
  chunkSize: number             // Chunk size used (8MB)
  createdAt: number
}

interface ChunkRef {
  index: number                 // Position in file
  hash: string                  // SHA-256 of chunk content (for dedup)
  encryptedHash: string         // SHA-256 of encrypted chunk (for lookup)
  size: number                  // Actual chunk size
}
```

### Deduplication Benefits

Same file attached to multiple notes → store chunks once:
- 50MB PDF attached twice = 50MB storage (not 100MB)
- Similar files share common chunks

---

## 9. WebSocket vs Polling for Real-time Sync

### Decision: WebSocket via Durable Objects, with polling fallback

### Rationale

WebSocket provides the best real-time experience:
- **Low latency**: < 100ms for note updates
- **Efficient**: No polling overhead
- **Durable Objects**: Handle WebSocket upgrades in Workers

### Implementation

```typescript
// Durable Object handles WebSocket connections
export class UserSyncState {
  private connections: Map<string, WebSocket> = new Map()

  async fetch(request: Request) {
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair()
      await this.handleSession(pair[1], request)
      return new Response(null, { status: 101, webSocket: pair[0] })
    }
    // Handle HTTP requests
  }

  async broadcast(message: SyncMessage, excludeDevice?: string) {
    for (const [deviceId, ws] of this.connections) {
      if (deviceId !== excludeDevice) {
        ws.send(JSON.stringify(message))
      }
    }
  }
}
```

### Fallback

- If WebSocket fails, fall back to polling every 30 seconds
- Client detects disconnection, auto-reconnects with exponential backoff

---

## 10. Vector Clock Implementation

### Decision: Per-field vector clocks for structured data

### Rationale

Tasks and settings are structured data with independent fields:
- Title, status, priority, due date can change independently
- Field-level LWW prevents unnecessary conflicts
- Vector clocks detect concurrent edits

### Implementation

```typescript
interface VectorClock {
  [deviceId: string]: number    // Logical timestamp per device
}

interface TaskWithSync extends Task {
  clock: VectorClock            // Overall item clock
  fieldClocks: {
    [field: string]: VectorClock  // Per-field clocks
  }
}

function mergeTask(local: TaskWithSync, remote: TaskWithSync): TaskWithSync {
  const fields = ['title', 'status', 'priority', 'dueDate', 'projectId']
  const merged = { ...local }

  for (const field of fields) {
    if (clockGreater(remote.fieldClocks[field], local.fieldClocks[field])) {
      merged[field] = remote[field]
      merged.fieldClocks[field] = remote.fieldClocks[field]
    }
  }

  merged.clock = mergeClock(local.clock, remote.clock)
  return merged
}
```

---

## 11. Offline Queue Persistence

### Decision: SQLite (data.db) via Drizzle

### Rationale

SQLite is the right choice for the sync queue in Electron:
- **Persistent**: Survives app crashes and restarts
- **Structured**: Indexed queries for type/status/timestamps
- **Shared**: Accessible from main process only (single writer)
- **Operational simplicity**: Reuses existing data.db + migrations

### Schema

```typescript
interface SyncQueueItem {
  id: string                    // Queue item ID
  type: 'note_update' | 'task' | 'project' | 'attachment' | 'settings'
  itemId: string                // ID of the synced item
  payload: string               // Encrypted JSON
  priority: number              // Higher = more urgent
  attempts: number              // Retry count
  lastAttempt: number | null    // Timestamp
  createdAt: number             // Timestamp
  status: 'pending' | 'in_progress' | 'failed'
}
```

### Retry Logic

```typescript
const RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000, 32000, 60000] // Max 60s

function getNextRetryDelay(attempts: number): number {
  return RETRY_DELAYS[Math.min(attempts, RETRY_DELAYS.length - 1)]
}

async function processQueue() {
  const pending = await db.getAll('sync_queue', 'by-status', 'pending')

  for (const item of pending) {
    if (item.attempts >= MAX_RETRIES) {
      await markFailed(item.id)
      continue
    }

    const delay = getNextRetryDelay(item.attempts)
    if (Date.now() < item.lastAttempt + delay) continue

    try {
      await syncItem(item)
      await remove(item.id)
    } catch (error) {
      await incrementAttempts(item.id)
    }
  }
}
```

---

## 12. Email Service Provider

### Decision: Resend for transactional emails

### Rationale

Resend offers the best developer experience for a small team:
- **Simple API**: Clean REST/SDK, no complex configuration
- **Deliverability**: Good inbox placement, DKIM/SPF built-in
- **Pricing**: Free tier (100 emails/day), affordable scaling
- **React Email**: First-class support for email templates
- **Cloudflare Workers**: Native fetch compatibility

### Alternatives Considered

| Provider | Pros | Cons | Decision |
|----------|------|------|----------|
| **Resend** | Simple, modern DX, React Email | Newer service | **Selected** |
| **SendGrid** | Mature, high volume | Complex setup, overkill | Rejected |
| **Postmark** | Great deliverability | More expensive | Backup option |
| **Cloudflare Email** | Native integration | Limited features, no templates | Rejected |
| **AWS SES** | Cheap at scale | Complex setup, cold start | Rejected |

### Implementation Notes

```typescript
// sync-server/src/services/email.ts
import { Resend } from 'resend'

const resend = new Resend(env.RESEND_API_KEY)

export async function sendVerificationEmail(email: string, token: string) {
  await resend.emails.send({
    from: 'Memry <noreply@memry.app>',
    to: email,
    subject: 'Verify your email',
    react: VerificationEmail({ token }),
  })
}
```

### Email Types

| Email | Trigger | Expiry |
|-------|---------|--------|
| OTP code | Login/signup request | 10 minutes |
| Device linked | New device approved | N/A |
| Device removed | Device revoked | N/A |

---

## 13. Sync State Machine

### Client Sync States

```
                                    ┌─────────────────┐
                                    │                 │
                           ┌────────│   INITIALIZING  │
                           │        │                 │
                           │        └────────┬────────┘
                           │                 │
                           │            (keys loaded)
                           │                 │
                           ▼                 ▼
┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
│                 │   │                 │   │                 │
│   OFFLINE       │◄──│     IDLE        │◄──│   SYNCING       │
│                 │   │                 │   │                 │
└────────┬────────┘   └────────┬────────┘   └────────┬────────┘
         │                     │                     │
         │                     │                     │
    (reconnect)           (change)              (complete)
         │                     │                     │
         │                     ▼                     │
         │            ┌─────────────────┐            │
         │            │                 │            │
         └───────────►│   SYNCING       │◄───────────┘
                      │                 │
                      └────────┬────────┘
                               │
                          (error)
                               │
                               ▼
                      ┌─────────────────┐
                      │                 │
                      │     ERROR       │──────► (retry) ──► SYNCING
                      │                 │
                      └─────────────────┘
```

### State Transitions

```typescript
type SyncState = 'initializing' | 'idle' | 'syncing' | 'offline' | 'error'

interface SyncStateContext {
  state: SyncState
  lastSyncAt?: number
  pendingCount: number
  errorMessage?: string
  retryCount: number
}

const transitions: Record<SyncState, SyncState[]> = {
  initializing: ['idle', 'offline', 'error'],
  idle: ['syncing', 'offline'],
  syncing: ['idle', 'error', 'offline'],
  offline: ['syncing', 'idle'],
  error: ['syncing', 'offline'],
}
```

### WebSocket Connection States

```
┌──────────┐  connect   ┌────────────┐  open    ┌───────────┐
│          │───────────►│            │─────────►│           │
│  CLOSED  │            │ CONNECTING │          │   OPEN    │
│          │◄───────────│            │◄─────────│           │
└──────────┘   close    └────────────┘  error   └───────────┘
      ▲                        │                      │
      │                        │                      │
      │              (max retries)              (server close)
      │                        │                      │
      │                        ▼                      │
      │               ┌────────────┐                  │
      │               │            │                  │
      └───────────────│   FAILED   │◄─────────────────┘
                      │            │
                      └────────────┘
```

### WebSocket Reconnection Strategy

```typescript
const RECONNECT_CONFIG = {
  initialDelay: 1000,       // 1 second
  maxDelay: 60000,          // 60 seconds
  multiplier: 2,            // Double each attempt
  jitter: 0.3,              // ±30% randomization
  maxAttempts: 10,          // Before falling back to polling
}

function getReconnectDelay(attempt: number): number {
  const baseDelay = Math.min(
    RECONNECT_CONFIG.initialDelay * Math.pow(RECONNECT_CONFIG.multiplier, attempt),
    RECONNECT_CONFIG.maxDelay
  )

  // Add jitter to prevent thundering herd
  const jitter = baseDelay * RECONNECT_CONFIG.jitter * (Math.random() * 2 - 1)
  return Math.round(baseDelay + jitter)
}

// Reconnection attempts: 1s, 2s, 4s, 8s, 16s, 32s, 60s, 60s, 60s, 60s
// With jitter: actual delays vary ±30%
```

---

## 14. Multi-Window Handling

### Challenge

Electron apps can have multiple windows. Each window shares:
- The same SQLite databases (via main process)
- The same LevelDB-backed Yjs persistence (via main process)
- The same sync queue

### Strategy: Single Writer

Only one window manages sync at a time:

```typescript
// Main process maintains sync ownership
let syncOwnerWindowId: number | null = null

function acquireSyncLock(windowId: number): boolean {
  if (syncOwnerWindowId === null || !BrowserWindow.fromId(syncOwnerWindowId)) {
    syncOwnerWindowId = windowId
    return true
  }
  return false
}

// When window closes, release lock
app.on('browser-window-closed', (_, window) => {
  if (syncOwnerWindowId === window.id) {
    syncOwnerWindowId = null
    // Next window to call acquireSyncLock gets ownership
  }
})
```

### Window Communication

```typescript
// All windows receive sync status updates via IPC
function broadcastSyncStatus(status: SyncStatus) {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('sync:status-changed', status)
  }
}

// Item changes are broadcast to all windows
function broadcastItemSynced(item: SyncedItem) {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('sync:item-synced', item)
  }
}
```

### CRDT Sync Across Windows

Yjs documents are shared via main-process persistence (LevelDB) and IPC broadcast:

```typescript
// Each window creates its own Y.Doc instance
// y-leveldb persists updates and the main process broadcasts changes via IPC
const doc = new Y.Doc()
const persistence = new LeveldbPersistence(`note-${noteId}`, doc)

// Changes in one window propagate to others via IPC broadcast from main
persistence.on('synced', () => {
  // Document is now in sync with other windows
})
```

---

## Open Questions Resolved

| Question | Resolution |
|----------|------------|
| Email authentication method | Passwordless OTP (6-digit codes) - simpler than passwords since recovery phrase is primary secret |
| Attachment storage limit per user | 5GB default (configurable in server config) |
| Sync conflict notification | Silent merge for CRDTs, log for vector clock merges |
| Real-time WebSocket | Always connected when app is foreground |
| Selective sync on desktop | Full sync only (P3 feature for mobile) |
| Key rotation frequency | Manual only, prompted after device removal |
| Email service provider | Resend for transactional emails |
| Multi-window sync | Single writer pattern, broadcast updates |
| WebSocket reconnection | Exponential backoff with jitter, max 60s |

---

## Next Steps

All research items resolved. Proceed to:
1. **Phase 1**: Generate data-model.md
2. **Phase 1**: Generate API contracts
3. **Phase 1**: Generate quickstart.md
