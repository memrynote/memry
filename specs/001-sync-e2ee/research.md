# Research: Sync Engine & E2EE

**Feature**: 001-sync-e2ee | **Date**: 2026-01-14

This document captures research findings and decisions for implementing the sync engine and end-to-end encryption system.

## Table of Contents

1. [Cryptography Library Selection](#1-cryptography-library-selection)
2. [Key Derivation Parameters](#2-key-derivation-parameters)
3. [CRDT Library for Notes](#3-crdt-library-for-notes)
4. [Sync Server Architecture](#4-sync-server-architecture)
5. [Email/Password Authentication](#5-emailpassword-authentication)
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

### Decision: Yjs with y-indexeddb

### Rationale

Yjs is the industry standard for collaborative text editing:
- **BlockNote integration**: Official collaboration support via `@blocknote/core`
- **Mature**: 5+ years of production use, well-documented
- **Efficient**: Binary encoding minimizes sync payload size
- **Awareness protocol**: Built-in support for cursors/presence (future collaboration)
- **Persistence**: y-indexeddb for offline support

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
import { IndexeddbPersistence } from 'y-indexeddb'

// Each note is a separate Yjs document
function createNoteDocument(noteId: string): Y.Doc {
  const doc = new Y.Doc({ guid: noteId })

  // Persist locally
  const persistence = new IndexeddbPersistence(`memry-note-${noteId}`, doc)

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

## 5. Email/Password Authentication

### Decision: Argon2id password hashing with email verification

### Rationale

For users who prefer not to use OAuth, email/password authentication provides a familiar, privacy-respecting alternative. Security requirements:
- **Password hashing**: Argon2id (same as key derivation, consistent with crypto choices)
- **Email verification**: Required before account is fully activated
- **Password requirements**: Min 12 chars, complexity enforced

### Password Requirements

```typescript
const PASSWORD_REQUIREMENTS = {
  minLength: 12,
  maxLength: 128,
  requireUppercase: true,
  requireLowercase: true,
  requireNumber: true,
  requireSpecialChar: true,
  // Matches: ^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*(),.?":{}|<>]).{12,128}$
}

function validatePassword(password: string): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (password.length < PASSWORD_REQUIREMENTS.minLength) {
    errors.push('Password must be at least 12 characters')
  }
  if (!/[a-z]/.test(password)) {
    errors.push('Password must contain a lowercase letter')
  }
  if (!/[A-Z]/.test(password)) {
    errors.push('Password must contain an uppercase letter')
  }
  if (!/\d/.test(password)) {
    errors.push('Password must contain a number')
  }
  if (!/[!@#$%^&*(),.?":{}|<>]/.test(password)) {
    errors.push('Password must contain a special character')
  }

  return { valid: errors.length === 0, errors }
}
```

### Password Hashing Parameters

Use same Argon2id parameters as key derivation for consistency:

```typescript
const PASSWORD_HASH_PARAMS = {
  memoryCost: 65536,      // 64 MB
  timeCost: 3,            // 3 iterations
  parallelism: 4,
  hashLength: 32,
  saltLength: 32
}

async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const salt = sodium.randombytes_buf(PASSWORD_HASH_PARAMS.saltLength)
  const hash = Buffer.alloc(PASSWORD_HASH_PARAMS.hashLength)

  sodium.crypto_pwhash(
    hash,
    Buffer.from(password),
    salt,
    PASSWORD_HASH_PARAMS.timeCost,
    PASSWORD_HASH_PARAMS.memoryCost * 1024,
    sodium.crypto_pwhash_ALG_ARGON2ID13
  )

  return {
    hash: hash.toString('base64'),
    salt: salt.toString('base64')
  }
}
```

### Email Verification Flow

```
User                        Server                      Email Service
─────                       ──────                      ─────────────
1. POST /auth/email/signup
   { email, password }
                    ──────────────────────────>
                    2. Validate email/password
                    3. Hash password with Argon2id
                    4. Generate verification token
                    5. Store user (email_verified=false)
                    6. Send verification email
                    ───────────────────────────────────>
                    <───────────────────────────────────
                    7. Return { message: "Check email" }
<──────────────────────────────
8. User clicks email link
9. POST /auth/email/verify
   { token }
                    ──────────────────────────>
                    10. Validate token
                    11. Set email_verified=true
                    12. Return AuthResult with tokens
<──────────────────────────────
```

### Security Measures

- **Rate limiting**: Max 5 signup/login attempts per email per hour
- **Token expiry**: Verification tokens expire in 24 hours
- **Password reset tokens**: Expire in 1 hour
- **Constant-time comparison**: For password verification to prevent timing attacks
- **No user enumeration**: Same response whether email exists or not

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

### Decision: IndexedDB via `idb` library

### Rationale

IndexedDB is the right choice for sync queue:
- **Persistent**: Survives app crashes and restarts
- **Large capacity**: No 5MB localStorage limit
- **Async**: Non-blocking operations
- **Structured**: Can query by type, status, timestamp

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

// IndexedDB indexes for efficient queries
const indexes = {
  'by-status': 'status',
  'by-type': 'type',
  'by-created': 'createdAt'
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

## Open Questions Resolved

| Question | Resolution |
|----------|------------|
| Attachment storage limit per user | 5GB default (configurable in server config) |
| Sync conflict notification | Silent merge for CRDTs, log for vector clock merges |
| Real-time WebSocket | Always connected when app is foreground |
| Selective sync on desktop | Full sync only (P3 feature for mobile) |
| Key rotation frequency | Manual only, prompted after device removal |

---

## Next Steps

All research items resolved. Proceed to:
1. **Phase 1**: Generate data-model.md
2. **Phase 1**: Generate API contracts
3. **Phase 1**: Generate quickstart.md
