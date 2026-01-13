# Sync Engine & E2E Encryption Specification

Secure synchronization between devices via encrypted central server, with CRDT-based conflict-free merging and collaboration support.

## USER STORIES

### P1 - Critical

1. As a user, I want my data synced across desktop and mobile so I see the same content everywhere
2. As a user, I want my data encrypted before leaving my device so even the server can't read it
3. As a user, I want sync to work when I come back online after being offline
4. As a user, I want to see sync status clearly (syncing, synced, error)
5. As a user, I want to link new devices securely
6. As a user, I want edits from multiple devices to merge automatically without losing work

### P2 - Important

7. As a user, I want to see sync activity history
8. As a user, I want to force sync manually if needed
9. As a user, I want to exclude certain items from sync (local-only notes)
10. As a user, I want sync to work in background without blocking my work
11. As a user, I want to share notes with collaborators (future)

### P3 - Nice to Have

12. As a user, I want selective sync (choose what to sync on mobile)
13. As a user, I want to see how much data is being used
14. As a user, I want sync pause option for metered connections
15. As a user, I want to remove a device from my account

---

## CRYPTOGRAPHIC DESIGN

### Key Hierarchy

```
Recovery Phrase (24 words BIP39)
        │
        ▼
    [Argon2id + Salt]
        │
        ▼
    Master Key (256-bit)
        │
        ├───────────────────┬────────────────────┐
        ▼                   ▼                    ▼
    Vault Key           Signing Key         Device Keys
    (HKDF derive)       (HKDF derive)       (HKDF per device)
        │                   │
        ▼                   ▼
    File Keys           Sign encrypted
    (random per item,   items for
    encrypted with      authenticity
    Vault Key)
```

### Key Purposes

| Key | Purpose | Storage |
|-----|---------|---------|
| Recovery Phrase | Regenerate master key if device lost | User writes down, never stored digitally |
| Master Key | Derive all other keys | OS Keychain (never leaves device) |
| Vault Key | Encrypt/decrypt file keys | Derived in memory when needed |
| Signing Key | Sign encrypted items to prove authenticity | Derived in memory when needed |
| File Keys | Encrypt individual items (notes, tasks) | Encrypted with Vault Key, stored on server |
| Device Keys | Authenticate device to server | OS Keychain per device |

### Encryption Scheme

```typescript
// Per-item encryption structure
interface EncryptedItem {
  id: string                      // UUID (unencrypted, for addressing)
  type: 'note' | 'task' | 'project' | 'settings'

  // Encrypted content
  encryptedKey: string            // File key encrypted with Vault Key (base64)
  keyNonce: string                // Nonce for key encryption (base64)
  encryptedData: string           // Content encrypted with File Key (base64)
  dataNonce: string               // Nonce for data encryption (base64)

  // Integrity
  signature: string               // Ed25519 signature over (id + encryptedData + dataNonce)

  // Sync metadata
  clock: VectorClock              // For conflict detection (tasks/settings)
  modifiedAt: number              // Server timestamp for ordering
}

// For CRDT-based items (notes), different structure
interface EncryptedCrdtItem {
  id: string
  type: 'note'

  // Full state snapshot (for initial sync / new devices)
  encryptedSnapshot: string       // Yjs encoded state, encrypted
  snapshotNonce: string
  stateVector: string             // Yjs state vector (base64, unencrypted for sync protocol)

  // Encrypted file key (same as above)
  encryptedKey: string
  keyNonce: string

  // Integrity
  signature: string

  // Incremental updates since snapshot
  updates: EncryptedUpdate[]
}

interface EncryptedUpdate {
  encryptedData: string           // Yjs update binary, encrypted with same file key
  nonce: string
  timestamp: number               // For ordering and compaction
  signature: string
}

// Vector clock for non-CRDT items
interface VectorClock {
  [deviceId: string]: number      // Logical timestamp per device
}
```

### Encryption Process

```typescript
// Encrypt a non-CRDT item (task, project, settings)
async function encryptItem(
  item: PlainItem,
  vaultKey: Uint8Array,
  signingKey: Uint8Array,
  deviceId: string,
  currentClock: VectorClock
): Promise<EncryptedItem> {
  // 1. Generate random file key (or reuse existing for updates)
  const fileKey = item.fileKey ?? crypto.getRandomValues(new Uint8Array(32))

  // 2. Encrypt content with file key (XChaCha20-Poly1305)
  const dataNonce = crypto.getRandomValues(new Uint8Array(24))
  const plaintext = new TextEncoder().encode(JSON.stringify(item.content))
  const encryptedData = await xchacha20poly1305Encrypt(fileKey, dataNonce, plaintext)

  // 3. Encrypt file key with vault key
  const keyNonce = crypto.getRandomValues(new Uint8Array(24))
  const encryptedKey = await xchacha20poly1305Encrypt(vaultKey, keyNonce, fileKey)

  // 4. Update vector clock
  const newClock = {
    ...currentClock,
    [deviceId]: (currentClock[deviceId] ?? 0) + 1
  }

  // 5. Sign the encrypted data
  const signaturePayload = new Uint8Array([
    ...new TextEncoder().encode(item.id),
    ...encryptedData,
    ...dataNonce
  ])
  const signature = await ed25519Sign(signingKey, signaturePayload)

  return {
    id: item.id,
    type: item.type,
    encryptedKey: base64Encode(encryptedKey),
    keyNonce: base64Encode(keyNonce),
    encryptedData: base64Encode(encryptedData),
    dataNonce: base64Encode(dataNonce),
    signature: base64Encode(signature),
    clock: newClock,
    modifiedAt: Date.now()
  }
}

// Encrypt a Yjs document (note)
async function encryptYjsDocument(
  noteId: string,
  doc: Y.Doc,
  vaultKey: Uint8Array,
  signingKey: Uint8Array
): Promise<EncryptedCrdtItem> {
  // 1. Get or generate file key for this note
  const fileKey = await getOrCreateFileKey(noteId, vaultKey)

  // 2. Encode Yjs state
  const state = Y.encodeStateAsUpdate(doc)
  const stateVector = Y.encodeStateVector(doc)

  // 3. Encrypt snapshot
  const snapshotNonce = crypto.getRandomValues(new Uint8Array(24))
  const encryptedSnapshot = await xchacha20poly1305Encrypt(fileKey, snapshotNonce, state)

  // 4. Sign
  const signaturePayload = new Uint8Array([
    ...new TextEncoder().encode(noteId),
    ...encryptedSnapshot,
    ...snapshotNonce
  ])
  const signature = await ed25519Sign(signingKey, signaturePayload)

  // 5. Encrypt file key
  const keyNonce = crypto.getRandomValues(new Uint8Array(24))
  const encryptedKey = await xchacha20poly1305Encrypt(vaultKey, keyNonce, fileKey)

  return {
    id: noteId,
    type: 'note',
    encryptedSnapshot: base64Encode(encryptedSnapshot),
    snapshotNonce: base64Encode(snapshotNonce),
    stateVector: base64Encode(stateVector),
    encryptedKey: base64Encode(encryptedKey),
    keyNonce: base64Encode(keyNonce),
    signature: base64Encode(signature),
    updates: []
  }
}

// Encrypt incremental Yjs update
async function encryptYjsUpdate(
  noteId: string,
  update: Uint8Array,
  fileKey: Uint8Array,
  signingKey: Uint8Array
): Promise<EncryptedUpdate> {
  const nonce = crypto.getRandomValues(new Uint8Array(24))
  const encryptedData = await xchacha20poly1305Encrypt(fileKey, nonce, update)

  const signaturePayload = new Uint8Array([
    ...new TextEncoder().encode(noteId),
    ...encryptedData,
    ...nonce
  ])
  const signature = await ed25519Sign(signingKey, signaturePayload)

  return {
    encryptedData: base64Encode(encryptedData),
    nonce: base64Encode(nonce),
    timestamp: Date.now(),
    signature: base64Encode(signature)
  }
}
```

### Key Derivation

```typescript
// Step 1: Generate recovery phrase (first device setup only)
function generateRecoveryPhrase(): string {
  // BIP39 with 256 bits of entropy = 24 words
  const entropy = crypto.getRandomValues(new Uint8Array(32))
  return entropyToMnemonic(entropy)
}

// Step 2: Derive master key from recovery phrase
async function deriveMasterKey(
  recoveryPhrase: string,
  salt: Uint8Array
): Promise<Uint8Array> {
  // Convert mnemonic to seed (BIP39 standard)
  const seed = await mnemonicToSeed(recoveryPhrase)

  // Derive master key with Argon2id (OWASP recommended parameters)
  const masterKey = await argon2id({
    password: seed,
    salt: salt,
    parallelism: 4,
    iterations: 3,
    memorySize: 65536,  // 64 MB
    hashLength: 32
  })

  return masterKey
}

// Step 3: Derive purpose-specific keys from master key
function deriveVaultKey(masterKey: Uint8Array): Uint8Array {
  return hkdf(masterKey, 'memry-vault-key-v1', 32)
}

function deriveSigningKey(masterKey: Uint8Array): Uint8Array {
  return hkdf(masterKey, 'memry-signing-key-v1', 32)
}

function deriveDeviceKey(masterKey: Uint8Array, deviceId: string): Uint8Array {
  return hkdf(masterKey, `memry-device-key-v1-${deviceId}`, 32)
}
```

### Why XChaCha20-Poly1305 over AES-GCM

| Feature | AES-GCM | XChaCha20-Poly1305 |
|---------|---------|---------------------|
| Nonce size | 12 bytes (96 bits) | 24 bytes (192 bits) |
| Nonce collision risk | Dangerous after ~2^32 messages | Safe for ~2^64 messages |
| Hardware acceleration | Requires AES-NI | Fast in software |
| Mobile performance | Slower without AES-NI | Consistent everywhere |

With per-file keys and frequent updates, XChaCha20's larger nonce provides better safety margin.

---

## CRDT ARCHITECTURE (Notes)

### Why CRDTs for Notes

Notes are rich text documents that may be:
- Edited on multiple devices while offline
- Eventually shared with collaborators

CRDTs (Conflict-free Replicated Data Types) merge all edits automatically. No conflicts, no lost work.

### Yjs Integration with BlockNote

```typescript
import * as Y from 'yjs'
import { BlockNoteEditor } from '@blocknote/core'

// Note document structure
interface NoteYjsDocument {
  id: string
  doc: Y.Doc

  // Convenience accessors
  content: Y.XmlFragment      // BlockNote rich text
  meta: Y.Map<any>            // title, created, modified
  tags: Y.Array<string>       // Tags as CRDT array
  properties: Y.Map<any>      // Custom properties
}

function createNoteDocument(noteId: string): NoteYjsDocument {
  const doc = new Y.Doc({ guid: noteId })

  return {
    id: noteId,
    doc,
    content: doc.getXmlFragment('content'),
    meta: doc.getMap('meta'),
    tags: doc.getArray('tags'),
    properties: doc.getMap('properties')
  }
}

// Initialize with defaults
function initializeNewNote(note: NoteYjsDocument, title: string): void {
  note.doc.transact(() => {
    note.meta.set('title', title)
    note.meta.set('created', Date.now())
    note.meta.set('modified', Date.now())
    note.meta.set('id', note.id)
  })
}

// BlockNote editor with Yjs
function createCollaborativeEditor(note: NoteYjsDocument): BlockNoteEditor {
  return BlockNoteEditor.create({
    collaboration: {
      fragment: note.content,
      user: {
        name: getCurrentUserName(),
        color: getUserColor()
      },
      // Provider connects to sync engine (implemented below)
      provider: createSyncProvider(note.id)
    }
  })
}
```

### Yjs Sync Provider

```typescript
import * as Y from 'yjs'
import { Observable } from 'lib0/observable'

class MemrySyncProvider extends Observable<string> {
  private doc: Y.Doc
  private noteId: string
  private fileKey: Uint8Array | null = null
  private connected: boolean = false
  private pendingUpdates: Uint8Array[] = []

  constructor(noteId: string, doc: Y.Doc) {
    super()
    this.noteId = noteId
    this.doc = doc

    // Listen for local changes
    this.doc.on('update', this.handleLocalUpdate.bind(this))
  }

  async connect(fileKey: Uint8Array): Promise<void> {
    this.fileKey = fileKey

    // Fetch current state from server
    const serverState = await this.fetchServerState()
    if (serverState) {
      Y.applyUpdate(this.doc, serverState)
    }

    // Subscribe to remote updates
    this.subscribeToUpdates()

    this.connected = true
    this.emit('status', [{ status: 'connected' }])

    // Flush any pending updates
    await this.flushPendingUpdates()
  }

  private async handleLocalUpdate(update: Uint8Array, origin: any): Promise<void> {
    // Skip updates from remote
    if (origin === 'remote') return

    if (!this.connected || !this.fileKey) {
      this.pendingUpdates.push(update)
      return
    }

    await this.pushUpdate(update)
  }

  private async pushUpdate(update: Uint8Array): Promise<void> {
    const encrypted = await encryptYjsUpdate(
      this.noteId,
      update,
      this.fileKey!,
      await getSigningKey()
    )

    await syncApi.pushNoteUpdate(this.noteId, encrypted)
  }

  private async fetchServerState(): Promise<Uint8Array | null> {
    const encrypted = await syncApi.getNoteSnapshot(this.noteId)
    if (!encrypted) return null

    // Verify signature
    if (!await verifySignature(encrypted)) {
      throw new Error('Invalid signature on server state')
    }

    return await decryptSnapshot(encrypted, this.fileKey!)
  }

  private subscribeToUpdates(): void {
    syncApi.subscribeToNote(this.noteId, async (encrypted: EncryptedUpdate) => {
      // Verify signature
      if (!await verifySignature(encrypted)) {
        console.error('Received update with invalid signature')
        return
      }

      const update = await decryptUpdate(encrypted, this.fileKey!)
      Y.applyUpdate(this.doc, update, 'remote')
    })
  }

  private async flushPendingUpdates(): Promise<void> {
    const updates = this.pendingUpdates
    this.pendingUpdates = []

    for (const update of updates) {
      await this.pushUpdate(update)
    }
  }

  disconnect(): void {
    syncApi.unsubscribeFromNote(this.noteId)
    this.connected = false
    this.emit('status', [{ status: 'disconnected' }])
  }
}
```

### Snapshot Compaction

Incremental updates accumulate over time. Periodically compact into snapshots:

```typescript
async function compactNoteUpdates(noteId: string): Promise<void> {
  const note = await loadNoteDocument(noteId)

  // Create fresh snapshot
  const snapshot = await encryptYjsDocument(
    noteId,
    note.doc,
    await getVaultKey(),
    await getSigningKey()
  )

  // Replace all updates with single snapshot
  await syncApi.replaceNoteState(noteId, snapshot)
}

// Compaction triggers
const COMPACTION_THRESHOLDS = {
  updateCount: 100,          // Compact after 100 updates
  updateSizeBytes: 1048576,  // Compact after 1MB of updates
  maxAgeMs: 86400000         // Compact daily
}
```

---

## NON-CRDT SYNC (Tasks, Projects, Settings)

### Vector Clock Conflict Resolution

For structured data (tasks, projects), use vector clocks with field-level last-writer-wins:

```typescript
interface Task {
  id: string
  title: string
  status: 'todo' | 'in_progress' | 'done'
  priority: number
  dueDate: string | null
  projectId: string | null

  // Sync metadata (not user-visible)
  clock: VectorClock
  fieldClocks: {
    [field: string]: VectorClock
  }
}

// Merge two versions of a task
function mergeTasks(local: Task, remote: Task, deviceId: string): Task {
  const merged: Task = { ...local }

  // For each field, take the one with higher clock
  const fields = ['title', 'status', 'priority', 'dueDate', 'projectId'] as const

  for (const field of fields) {
    const localClock = local.fieldClocks[field] ?? {}
    const remoteClock = remote.fieldClocks[field] ?? {}

    if (compareClocks(remoteClock, localClock) > 0) {
      merged[field] = remote[field]
      merged.fieldClocks[field] = remoteClock
    }
  }

  // Merge the overall clock
  merged.clock = mergeClocks(local.clock, remote.clock)

  return merged
}

// Compare vector clocks: -1 (a < b), 0 (concurrent), 1 (a > b)
function compareClocks(a: VectorClock, b: VectorClock): number {
  const allDevices = new Set([...Object.keys(a), ...Object.keys(b)])

  let aGreater = false
  let bGreater = false

  for (const device of allDevices) {
    const aVal = a[device] ?? 0
    const bVal = b[device] ?? 0

    if (aVal > bVal) aGreater = true
    if (bVal > aVal) bGreater = true
  }

  if (aGreater && !bGreater) return 1
  if (bGreater && !aGreater) return -1
  return 0  // Concurrent
}

function mergeClocks(a: VectorClock, b: VectorClock): VectorClock {
  const merged: VectorClock = { ...a }
  for (const [device, time] of Object.entries(b)) {
    merged[device] = Math.max(merged[device] ?? 0, time)
  }
  return merged
}
```

---

## DEVICE SETUP & LINKING

### First Device Setup

```
┌─────────────────────────────────────────────────────────────────┐
│  1. User signs up (OAuth: Google/Apple/GitHub)                  │
│                              │                                  │
│                              ▼                                  │
│  2. Generate recovery phrase (24 words BIP39)                   │
│     └── Display clearly, require user to confirm                │
│                              │                                  │
│                              ▼                                  │
│  3. Generate random salt (32 bytes)                             │
│                              │                                  │
│                              ▼                                  │
│  4. Derive master key from recovery phrase + salt               │
│     └── masterKey = Argon2id(mnemonicToSeed(phrase), salt)      │
│                              │                                  │
│                              ▼                                  │
│  5. Store master key in OS Keychain                             │
│     └── NEVER store recovery phrase                             │
│                              │                                  │
│                              ▼                                  │
│  6. Generate device ID (UUID)                                   │
│                              │                                  │
│                              ▼                                  │
│  7. Upload to server (encrypted):                               │
│     ├── Salt (encrypted with master key)                        │
│     ├── Device public key (for device auth)                     │
│     └── Account verification hash                               │
│                              │                                  │
│                              ▼                                  │
│  8. Sync is now active                                          │
└─────────────────────────────────────────────────────────────────┘
```

```typescript
async function setupFirstDevice(oauthToken: string): Promise<SetupResult> {
  // 1. Verify OAuth and get user ID
  const user = await verifyOAuth(oauthToken)

  // 2. Generate recovery phrase
  const recoveryPhrase = generateRecoveryPhrase()

  // 3. Generate salt
  const salt = crypto.getRandomValues(new Uint8Array(32))

  // 4. Derive master key
  const masterKey = await deriveMasterKey(recoveryPhrase, salt)

  // 5. Store in keychain
  await keychain.set('memry-master-key', masterKey)

  // 6. Generate device ID
  const deviceId = crypto.randomUUID()
  await keychain.set('memry-device-id', deviceId)

  // 7. Derive device key and create keypair for server auth
  const deviceKey = deriveDeviceKey(masterKey, deviceId)
  const deviceKeypair = await ed25519GenerateKeypair(deviceKey)

  // 8. Encrypt salt for server storage
  const vaultKey = deriveVaultKey(masterKey)
  const encryptedSalt = await encrypt(salt, vaultKey)

  // 9. Create verification hash (proves we have the right key later)
  const verificationHash = await hash(masterKey)

  // 10. Upload to server
  await api.post('/account/setup', {
    userId: user.id,
    deviceId,
    devicePublicKey: base64Encode(deviceKeypair.publicKey),
    encryptedSalt: base64Encode(encryptedSalt),
    verificationHash: base64Encode(verificationHash)
  })

  return {
    recoveryPhrase,  // Show to user ONCE, never store
    deviceId
  }
}
```

### Device Linking - QR Code Method (Recommended)

```
┌─────────────────────────────────────────────────────────────────┐
│  EXISTING DEVICE                    NEW DEVICE                  │
│  ──────────────                     ──────────                  │
│                                                                 │
│  1. Go to Settings > Devices        1. Click "Link Account"     │
│     > Link New Device                                           │
│                                     2. Sign in with OAuth       │
│  2. Generate ephemeral ECDH         │                           │
│     keypair                         │                           │
│                                     │                           │
│  3. Generate one-time token         │                           │
│     (server-verified)               │                           │
│                                     │                           │
│  4. Display QR code containing:     3. Scan QR code             │
│     ├── Ephemeral public key        │                           │
│     ├── One-time token              │                           │
│     └── Expiry (5 minutes)          │                           │
│                                     │                           │
│           ─────────────────────────►│                           │
│                                     │                           │
│                                     4. Generate own ECDH        │
│                                        keypair                  │
│                                     │                           │
│                                     5. Compute shared secret    │
│                                        via ECDH                 │
│                                     │                           │
│                                     6. Send to server:          │
│                                        ├── One-time token       │
│                                        └── New device public key│
│                                     │                           │
│  5. Server notifies: linking        │                           │
│     request received                │                           │
│                                     │                           │
│  6. Approve on existing device      │                           │
│                                     │                           │
│  7. Encrypt master key with         │                           │
│     ECDH shared secret              │                           │
│                                     │                           │
│  8. Send encrypted master key       │                           │
│     via server                ─────►│                           │
│                                     │                           │
│                                     7. Decrypt master key       │
│                                     │                           │
│                                     8. Store in keychain        │
│                                     │                           │
│                                     9. Sync begins              │
└─────────────────────────────────────────────────────────────────┘
```

```typescript
// Existing device: generate QR code
async function generateLinkingQRCode(): Promise<{ qrData: string; sessionId: string }> {
  // Generate ephemeral ECDH keypair (X25519)
  const ephemeralKeypair = await x25519GenerateKeypair()

  // Request one-time token from server
  const { token, sessionId } = await api.post('/linking/initiate', {
    deviceId: getDeviceId(),
    ephemeralPublicKey: base64Encode(ephemeralKeypair.publicKey)
  })

  // Store private key temporarily (cleared after linking or timeout)
  await secureStorage.set(`linking-${sessionId}`, {
    privateKey: ephemeralKeypair.privateKey,
    expires: Date.now() + 5 * 60 * 1000  // 5 minutes
  })

  const qrPayload: LinkingQRPayload = {
    v: 1,  // Version
    pub: base64Encode(ephemeralKeypair.publicKey),
    tok: token,
    exp: Date.now() + 5 * 60 * 1000
  }

  return {
    qrData: JSON.stringify(qrPayload),
    sessionId
  }
}

// New device: scan and link
async function linkViaQRCode(qrData: string, oauthToken: string): Promise<void> {
  const payload: LinkingQRPayload = JSON.parse(qrData)

  // Check expiry
  if (Date.now() > payload.exp) {
    throw new Error('QR code expired')
  }

  // Generate our ECDH keypair
  const ourKeypair = await x25519GenerateKeypair()

  // Compute shared secret
  const theirPublicKey = base64Decode(payload.pub)
  const sharedSecret = await x25519ComputeSharedSecret(ourKeypair.privateKey, theirPublicKey)

  // Derive encryption key from shared secret
  const linkingKey = hkdf(sharedSecret, 'memry-linking-v1', 32)

  // Verify OAuth and get user
  const user = await verifyOAuth(oauthToken)

  // Generate device ID
  const deviceId = crypto.randomUUID()
  const deviceKeypair = await ed25519GenerateKeypair()

  // Request linking from server
  const { encryptedMasterKey } = await api.post('/linking/complete', {
    token: payload.tok,
    userId: user.id,
    deviceId,
    devicePublicKey: base64Encode(deviceKeypair.publicKey),
    newDeviceEphemeralPublicKey: base64Encode(ourKeypair.publicKey)
  })

  // Decrypt master key
  const masterKey = await xchacha20poly1305Decrypt(
    linkingKey,
    base64Decode(encryptedMasterKey.nonce),
    base64Decode(encryptedMasterKey.ciphertext)
  )

  // Store in keychain
  await keychain.set('memry-master-key', masterKey)
  await keychain.set('memry-device-id', deviceId)

  // Start sync
  await initializeSync()
}

// Existing device: approve and send key
async function approveLinkingRequest(sessionId: string): Promise<void> {
  // Get stored ephemeral key
  const stored = await secureStorage.get(`linking-${sessionId}`)
  if (!stored || Date.now() > stored.expires) {
    throw new Error('Linking session expired')
  }

  // Get new device's public key from server
  const { newDevicePublicKey } = await api.get(`/linking/pending/${sessionId}`)

  // Compute shared secret
  const sharedSecret = await x25519ComputeSharedSecret(
    stored.privateKey,
    base64Decode(newDevicePublicKey)
  )
  const linkingKey = hkdf(sharedSecret, 'memry-linking-v1', 32)

  // Encrypt master key
  const masterKey = await keychain.get('memry-master-key')
  const nonce = crypto.getRandomValues(new Uint8Array(24))
  const encryptedMasterKey = await xchacha20poly1305Encrypt(linkingKey, nonce, masterKey)

  // Send to server for new device
  await api.post(`/linking/approve/${sessionId}`, {
    encryptedMasterKey: {
      ciphertext: base64Encode(encryptedMasterKey),
      nonce: base64Encode(nonce)
    }
  })

  // Clean up
  await secureStorage.delete(`linking-${sessionId}`)
}
```

### Device Linking - Recovery Phrase Method

```typescript
async function linkViaRecoveryPhrase(
  recoveryPhrase: string,
  oauthToken: string
): Promise<void> {
  // Verify OAuth
  const user = await verifyOAuth(oauthToken)

  // Fetch encrypted salt from server
  const { encryptedSalt, verificationHash } = await api.get(`/account/${user.id}/recovery`)

  // We need to derive the vault key first to decrypt the salt
  // But we need the salt to derive the master key... chicken and egg!
  // Solution: use a fixed "recovery salt" for the initial derivation
  const recoverySalt = new TextEncoder().encode(`memry-recovery-${user.id}`)
  const recoveryKey = await deriveMasterKey(recoveryPhrase, recoverySalt)

  // Decrypt the actual salt
  const vaultKey = deriveVaultKey(recoveryKey)
  const salt = await decrypt(base64Decode(encryptedSalt), vaultKey)

  // Now derive the real master key
  const masterKey = await deriveMasterKey(recoveryPhrase, salt)

  // Verify we got the right key
  const computedHash = await hash(masterKey)
  if (!constantTimeEqual(computedHash, base64Decode(verificationHash))) {
    throw new Error('Invalid recovery phrase')
  }

  // Store and continue
  await keychain.set('memry-master-key', masterKey)

  // Register this device
  const deviceId = crypto.randomUUID()
  await keychain.set('memry-device-id', deviceId)

  const deviceKeypair = await ed25519GenerateKeypair()
  await api.post('/account/add-device', {
    userId: user.id,
    deviceId,
    devicePublicKey: base64Encode(deviceKeypair.publicKey)
  })

  await initializeSync()
}
```

---

## SYNC PROTOCOL

### Architecture Overview

```
┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐
│   Device A      │         │     Server      │         │   Device B      │
│                 │         │   (Zero-Know)   │         │                 │
│  ┌───────────┐  │         │  ┌───────────┐  │         │  ┌───────────┐  │
│  │ Yjs Docs  │  │◄───────►│  │ Encrypted │  │◄───────►│  │ Yjs Docs  │  │
│  │ (Notes)   │  │         │  │   Blobs   │  │         │  │ (Notes)   │  │
│  └───────────┘  │         │  └───────────┘  │         │  └───────────┘  │
│                 │         │                 │         │                 │
│  ┌───────────┐  │         │  ┌───────────┐  │         │  ┌───────────┐  │
│  │  Tasks    │  │◄───────►│  │ Encrypted │  │◄───────►│  │  Tasks    │  │
│  │ (Vector   │  │         │  │   Blobs   │  │         │  │ (Vector   │  │
│  │  Clocks)  │  │         │  │           │  │         │  │  Clocks)  │  │
│  └───────────┘  │         │  └───────────┘  │         │  └───────────┘  │
│                 │         │                 │         │                 │
│  ┌───────────┐  │         │                 │         │  ┌───────────┐  │
│  │Sync Queue │  │         │                 │         │  │Sync Queue │  │
│  │(IndexedDB)│  │         │                 │         │  │(IndexedDB)│  │
│  └───────────┘  │         │                 │         │  └───────────┘  │
└─────────────────┘         └─────────────────┘         └─────────────────┘

Server stores ONLY:
- Encrypted blobs (can't read content)
- Item IDs (for addressing)
- Timestamps (for ordering)
- State vectors (for CRDT sync)
```

### Push Protocol

```typescript
// Sync queue persists across app restarts
interface SyncQueueItem {
  id: string
  type: 'note_update' | 'task' | 'project' | 'settings' | 'attachment'
  itemId: string
  payload: EncryptedItem | EncryptedUpdate
  attempts: number
  lastAttempt: number | null
  createdAt: number
}

class SyncEngine {
  private queue: SyncQueue
  private ws: WebSocket | null = null
  private status: SyncStatus = { state: 'idle', lastSync: new Date() }

  // Push local changes to server
  async push(): Promise<void> {
    const items = await this.queue.getPending()
    if (items.length === 0) return

    this.setStatus({ state: 'syncing', itemsRemaining: items.length })

    for (const item of items) {
      try {
        await this.pushItem(item)
        await this.queue.markCompleted(item.id)
        this.setStatus({
          state: 'syncing',
          itemsRemaining: items.length - 1
        })
      } catch (error) {
        await this.handlePushError(item, error)
      }
    }

    this.setStatus({ state: 'idle', lastSync: new Date() })
  }

  private async pushItem(item: SyncQueueItem): Promise<void> {
    switch (item.type) {
      case 'note_update':
        await this.pushNoteUpdate(item)
        break
      case 'task':
      case 'project':
        await this.pushWithVectorClock(item)
        break
      case 'attachment':
        await this.pushAttachment(item)
        break
    }
  }

  private async pushNoteUpdate(item: SyncQueueItem): Promise<void> {
    const response = await api.post(`/sync/notes/${item.itemId}/updates`, {
      update: item.payload
    })

    // Server might ask us to send full snapshot if too many updates
    if (response.needsSnapshot) {
      await this.pushNoteSnapshot(item.itemId)
    }
  }

  private async pushWithVectorClock(item: SyncQueueItem): Promise<void> {
    const response = await api.post(`/sync/${item.type}s/${item.itemId}`, {
      encrypted: item.payload
    })

    // Server returns merged result if there were concurrent changes
    if (response.merged) {
      const decrypted = await this.decrypt(response.merged)
      await this.applyMergedItem(item.type, decrypted)
    }
  }

  private async handlePushError(item: SyncQueueItem, error: Error): Promise<void> {
    item.attempts++
    item.lastAttempt = Date.now()

    if (item.attempts >= MAX_RETRIES) {
      await this.queue.markFailed(item.id, error.message)
      this.setStatus({
        state: 'error',
        error: `Failed to sync ${item.type}`,
        retryAt: new Date(Date.now() + RETRY_DELAY)
      })
    } else {
      // Exponential backoff
      const delay = Math.min(1000 * Math.pow(2, item.attempts), 60000)
      await this.queue.scheduleRetry(item.id, Date.now() + delay)
    }
  }
}
```

### Pull Protocol

```typescript
class SyncEngine {
  // ... continued from above

  // Connect to server for real-time updates
  async connect(): Promise<void> {
    const deviceId = await keychain.get('memry-device-id')
    const authToken = await this.getAuthToken()

    this.ws = new WebSocket(`wss://sync.memry.app/v1/sync`)

    this.ws.onopen = () => {
      this.ws!.send(JSON.stringify({
        type: 'auth',
        deviceId,
        token: authToken
      }))
    }

    this.ws.onmessage = async (event) => {
      const message = JSON.parse(event.data)
      await this.handleServerMessage(message)
    }

    this.ws.onclose = () => {
      this.setStatus({ state: 'offline', queueSize: this.queue.size() })
      this.scheduleReconnect()
    }
  }

  private async handleServerMessage(message: ServerMessage): Promise<void> {
    switch (message.type) {
      case 'note_update':
        await this.applyNoteUpdate(message)
        break
      case 'item_changed':
        await this.pullItem(message.itemType, message.itemId)
        break
      case 'item_deleted':
        await this.deleteLocalItem(message.itemType, message.itemId)
        break
      case 'full_sync_required':
        await this.performFullSync()
        break
    }
  }

  private async applyNoteUpdate(message: NoteUpdateMessage): Promise<void> {
    const { noteId, encryptedUpdate } = message

    // Verify signature
    if (!await this.verifySignature(encryptedUpdate)) {
      console.error('Received update with invalid signature, ignoring')
      return
    }

    // Get file key for this note
    const fileKey = await this.getFileKey(noteId)

    // Decrypt update
    const update = await xchacha20poly1305Decrypt(
      fileKey,
      base64Decode(encryptedUpdate.nonce),
      base64Decode(encryptedUpdate.encryptedData)
    )

    // Apply to local Yjs document
    const doc = await this.getYjsDocument(noteId)
    Y.applyUpdate(doc, update, 'remote')

    // Emit event for UI to update
    this.emit('noteUpdated', noteId)
  }

  private async pullItem(type: string, itemId: string): Promise<void> {
    const response = await api.get(`/sync/${type}s/${itemId}`)

    // Verify signature
    if (!await this.verifySignature(response.encrypted)) {
      throw new Error('Invalid signature on pulled item')
    }

    // Decrypt
    const decrypted = await this.decrypt(response.encrypted)

    // Merge with local (for vector clock items)
    const local = await this.getLocalItem(type, itemId)
    if (local) {
      const merged = this.mergeItems(local, decrypted)
      await this.saveLocalItem(type, merged)
    } else {
      await this.saveLocalItem(type, decrypted)
    }

    this.emit('itemUpdated', { type, itemId })
  }

  // Full sync for new device or recovery
  private async performFullSync(): Promise<void> {
    this.setStatus({ state: 'syncing', itemsRemaining: -1 })

    // Get list of all items from server
    const manifest = await api.get('/sync/manifest')

    // Pull all items
    const total = manifest.notes.length + manifest.tasks.length + manifest.projects.length
    let completed = 0

    // Notes: pull snapshots + updates
    for (const noteRef of manifest.notes) {
      await this.pullNoteSnapshot(noteRef.id, noteRef.stateVector)
      completed++
      this.setStatus({ state: 'syncing', itemsRemaining: total - completed })
    }

    // Tasks and projects: pull full items
    for (const taskRef of manifest.tasks) {
      await this.pullItem('task', taskRef.id)
      completed++
      this.setStatus({ state: 'syncing', itemsRemaining: total - completed })
    }

    for (const projectRef of manifest.projects) {
      await this.pullItem('project', projectRef.id)
      completed++
      this.setStatus({ state: 'syncing', itemsRemaining: total - completed })
    }

    this.setStatus({ state: 'idle', lastSync: new Date() })
  }
}
```

### Offline Support

```typescript
class SyncQueue {
  private db: IDBDatabase

  constructor() {
    this.db = await openDatabase('memry-sync-queue', 1, (db) => {
      db.createObjectStore('queue', { keyPath: 'id' })
      db.createObjectStore('failed', { keyPath: 'id' })
    })
  }

  async enqueue(item: Omit<SyncQueueItem, 'id' | 'attempts' | 'lastAttempt' | 'createdAt'>): Promise<void> {
    const queueItem: SyncQueueItem = {
      ...item,
      id: crypto.randomUUID(),
      attempts: 0,
      lastAttempt: null,
      createdAt: Date.now()
    }

    await this.db.put('queue', queueItem)
  }

  async getPending(): Promise<SyncQueueItem[]> {
    const all = await this.db.getAll('queue')
    const now = Date.now()

    return all.filter(item => {
      if (!item.lastAttempt) return true
      // Respect backoff schedule
      const backoff = Math.min(1000 * Math.pow(2, item.attempts), 60000)
      return now >= item.lastAttempt + backoff
    })
  }

  async markCompleted(id: string): Promise<void> {
    await this.db.delete('queue', id)
  }

  async markFailed(id: string, error: string): Promise<void> {
    const item = await this.db.get('queue', id)
    await this.db.delete('queue', id)
    await this.db.put('failed', { ...item, error, failedAt: Date.now() })
  }

  size(): number {
    return this.db.count('queue')
  }
}

// Network status handling
class NetworkMonitor {
  private online: boolean = navigator.onLine
  private listeners: Set<(online: boolean) => void> = new Set()

  constructor() {
    window.addEventListener('online', () => this.setOnline(true))
    window.addEventListener('offline', () => this.setOnline(false))
  }

  private setOnline(online: boolean): void {
    if (this.online === online) return
    this.online = online
    this.listeners.forEach(fn => fn(online))
  }

  onStatusChange(fn: (online: boolean) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  isOnline(): boolean {
    return this.online
  }
}

// Integrate with sync engine
syncEngine.on('ready', () => {
  networkMonitor.onStatusChange(async (online) => {
    if (online) {
      // Reconnect and flush queue
      await syncEngine.connect()
      await syncEngine.push()
    } else {
      syncEngine.disconnect()
    }
  })
})
```

---

## SYNC STATUS UI

```typescript
type SyncStatus =
  | { state: 'idle'; lastSync: Date }
  | { state: 'syncing'; itemsRemaining: number }
  | { state: 'error'; error: string; retryAt: Date }
  | { state: 'offline'; queueSize: number }

// React component
function SyncStatusIndicator() {
  const status = useSyncStatus()

  switch (status.state) {
    case 'idle':
      return (
        <div className="flex items-center gap-2 text-green-600">
          <CheckCircle size={16} />
          <span>Synced {formatRelative(status.lastSync)}</span>
        </div>
      )

    case 'syncing':
      return (
        <div className="flex items-center gap-2 text-blue-600">
          <Loader2 size={16} className="animate-spin" />
          <span>
            {status.itemsRemaining > 0
              ? `Syncing ${status.itemsRemaining} items...`
              : 'Syncing...'}
          </span>
        </div>
      )

    case 'error':
      return (
        <div className="flex items-center gap-2 text-red-600">
          <AlertCircle size={16} />
          <span>{status.error}</span>
          <button onClick={() => syncEngine.retry()}>
            Retry
          </button>
        </div>
      )

    case 'offline':
      return (
        <div className="flex items-center gap-2 text-yellow-600">
          <WifiOff size={16} />
          <span>Offline ({status.queueSize} pending)</span>
        </div>
      )
  }
}
```

---

## WHAT GETS SYNCED

```
SYNCED (encrypted):
├── Notes (Yjs CRDT documents)
│   ├── Content (rich text)
│   ├── Frontmatter (title, properties)
│   └── Tags
├── Tasks (vector clock)
│   ├── All task fields
│   └── Per-field clocks
├── Projects (vector clock)
├── Statuses (vector clock)
├── Inbox items (vector clock)
├── Attachments (encrypted blobs)
│   ├── Images
│   ├── Voice recordings
│   └── Other files
└── Account Settings (vector clock)
    ├── Default views
    └── Keyboard shortcuts

NOT SYNCED (local only):
├── index.db (cache, rebuilt from synced data)
├── FTS search index (rebuilt locally)
├── Device Settings
│   ├── Theme
│   ├── Window size/position
│   ├── Panel widths
│   └── Recently opened
├── Sync queue (local bookkeeping)
├── Temp files
└── Yjs awareness state (ephemeral)
```

---

## BINARY FILE SYNC (Attachments)

Binary files (PDFs, videos, images, audio) require special handling due to size, memory constraints, and lack of merge semantics.

### Architecture: Chunked Content-Addressable Storage

```
┌─────────────────────────────────────────────────────────────────────┐
│  Original File (e.g., 50MB PDF)                                     │
│                                                                     │
│  ┌──────────┬──────────┬──────────┬──────────┬──────────┬────────┐  │
│  │ Chunk 1  │ Chunk 2  │ Chunk 3  │ Chunk 4  │ Chunk 5  │ Chunk 6│  │
│  │   8MB    │   8MB    │   8MB    │   8MB    │   8MB    │  10MB  │  │
│  └────┬─────┴────┬─────┴────┬─────┴────┬─────┴────┬─────┴───┬────┘  │
│       │          │          │          │          │         │       │
│       ▼          ▼          ▼          ▼          ▼         ▼       │
│  ┌─────────┐┌─────────┐┌─────────┐┌─────────┐┌─────────┐┌─────────┐ │
│  │Encrypt  ││Encrypt  ││Encrypt  ││Encrypt  ││Encrypt  ││Encrypt  │ │
│  │+ Hash   ││+ Hash   ││+ Hash   ││+ Hash   ││+ Hash   ││+ Hash   │ │
│  └────┬────┘└────┬────┘└────┬────┘└────┬────┘└────┬────┘└────┬────┘ │
│       │          │          │          │          │         │       │
│       ▼          ▼          ▼          ▼          ▼         ▼       │
│    hash_a     hash_b     hash_c     hash_d     hash_e    hash_f    │
│                                                                     │
│  Manifest (encrypted with file key):                                │
│  {                                                                  │
│    "filename": "document.pdf",                                      │
│    "size": 50000000,                                                │
│    "mimeType": "application/pdf",                                   │
│    "chunks": ["hash_a", "hash_b", ...],                             │
│    "chunkSize": 8388608                                             │
│  }                                                                  │
└─────────────────────────────────────────────────────────────────────┘
```

### Data Structures

```typescript
// Attachment reference (stored with note/task)
interface AttachmentRef {
  id: string                    // Unique ID for this attachment
  manifestId: string            // Points to encrypted manifest
  filename: string              // Original filename
  size: number                  // For progress display
  mimeType: string
  thumbnail?: string            // Base64 thumbnail for images/videos/PDFs
  createdAt: number
}

// Manifest (encrypted, stored on server)
interface AttachmentManifest {
  id: string
  filename: string
  size: number
  mimeType: string
  checksum: string              // SHA-256 of original file
  chunks: ChunkRef[]
  chunkSize: number             // e.g., 8MB (8388608 bytes)
  createdAt: number
}

interface ChunkRef {
  index: number
  hash: string                  // Content hash (for dedup + verification)
  encryptedHash: string         // Hash of encrypted chunk (for server lookup)
  size: number                  // Actual chunk size
}

// Encrypted chunk (stored on server)
interface EncryptedChunk {
  hash: string                  // Content-addressable ID
  encryptedData: Uint8Array     // Encrypted chunk data
  nonce: string
}
```

### Upload Process

```typescript
const CHUNK_SIZE = 8 * 1024 * 1024  // 8MB chunks

async function uploadAttachment(
  file: File,
  noteId: string,
  vaultKey: Uint8Array,
  onProgress: (progress: number) => void
): Promise<AttachmentRef> {
  // 1. Generate file key for this attachment
  const fileKey = crypto.getRandomValues(new Uint8Array(32))

  // 2. Calculate total chunks
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE)
  const chunks: ChunkRef[] = []

  // 3. Process each chunk
  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE
    const end = Math.min(start + CHUNK_SIZE, file.size)
    const chunkData = await file.slice(start, end).arrayBuffer()

    // Hash original chunk (for dedup check)
    const contentHash = await sha256(new Uint8Array(chunkData))

    // Check if chunk already exists on server (dedup)
    const exists = await api.checkChunkExists(base64Encode(contentHash))

    let encryptedHash: Uint8Array

    if (!exists) {
      // Encrypt chunk
      const nonce = crypto.getRandomValues(new Uint8Array(24))
      const encryptedData = await xchacha20poly1305Encrypt(
        fileKey,
        nonce,
        new Uint8Array(chunkData)
      )

      encryptedHash = await sha256(encryptedData)

      // Upload encrypted chunk
      await api.uploadChunk({
        hash: base64Encode(contentHash),
        encryptedHash: base64Encode(encryptedHash),
        encryptedData,
        nonce: base64Encode(nonce)
      })
    } else {
      // Chunk exists, get its encrypted hash
      const existing = await api.getChunkMeta(base64Encode(contentHash))
      encryptedHash = base64Decode(existing.encryptedHash)
    }

    chunks.push({
      index: i,
      hash: base64Encode(contentHash),
      encryptedHash: base64Encode(encryptedHash),
      size: end - start
    })

    onProgress((i + 1) / totalChunks)
  }

  // 4. Create and encrypt manifest
  const manifest: AttachmentManifest = {
    id: crypto.randomUUID(),
    filename: file.name,
    size: file.size,
    mimeType: file.type,
    checksum: await sha256File(file),
    chunks,
    chunkSize: CHUNK_SIZE,
    createdAt: Date.now()
  }

  // Encrypt manifest with file key
  const manifestNonce = crypto.getRandomValues(new Uint8Array(24))
  const encryptedManifest = await xchacha20poly1305Encrypt(
    fileKey,
    manifestNonce,
    new TextEncoder().encode(JSON.stringify(manifest))
  )

  // 5. Encrypt file key with vault key
  const keyNonce = crypto.getRandomValues(new Uint8Array(24))
  const encryptedFileKey = await xchacha20poly1305Encrypt(vaultKey, keyNonce, fileKey)

  // 6. Upload manifest + encrypted file key
  await api.uploadManifest(manifest.id, {
    encryptedManifest: base64Encode(encryptedManifest),
    manifestNonce: base64Encode(manifestNonce),
    encryptedFileKey: base64Encode(encryptedFileKey),
    keyNonce: base64Encode(keyNonce)
  })

  // 7. Generate thumbnail for preview
  const thumbnail = await generateThumbnail(file)

  return {
    id: crypto.randomUUID(),
    manifestId: manifest.id,
    filename: file.name,
    size: file.size,
    mimeType: file.type,
    thumbnail,
    createdAt: Date.now()
  }
}
```

### Download Process

```typescript
async function downloadAttachment(
  attachmentRef: AttachmentRef,
  vaultKey: Uint8Array,
  onProgress: (progress: number) => void
): Promise<Blob> {
  // 1. Fetch manifest and file key
  const {
    encryptedManifest,
    manifestNonce,
    encryptedFileKey,
    keyNonce
  } = await api.getManifest(attachmentRef.manifestId)

  // 2. Decrypt file key
  const fileKey = await xchacha20poly1305Decrypt(
    vaultKey,
    base64Decode(keyNonce),
    base64Decode(encryptedFileKey)
  )

  // 3. Decrypt manifest
  const manifestBytes = await xchacha20poly1305Decrypt(
    fileKey,
    base64Decode(manifestNonce),
    base64Decode(encryptedManifest)
  )
  const manifest: AttachmentManifest = JSON.parse(
    new TextDecoder().decode(manifestBytes)
  )

  // 4. Download and decrypt chunks
  const decryptedChunks: Uint8Array[] = []

  for (let i = 0; i < manifest.chunks.length; i++) {
    const chunkRef = manifest.chunks[i]

    // Fetch encrypted chunk
    const { encryptedData, nonce } = await api.getChunk(chunkRef.hash)

    // Decrypt chunk
    const decrypted = await xchacha20poly1305Decrypt(
      fileKey,
      base64Decode(nonce),
      encryptedData
    )

    // Verify content hash
    const computedHash = await sha256(decrypted)
    if (base64Encode(computedHash) !== chunkRef.hash) {
      throw new Error(`Chunk ${i} integrity check failed`)
    }

    decryptedChunks.push(decrypted)
    onProgress((i + 1) / manifest.chunks.length)
  }

  // 5. Reassemble file
  const fullFile = concatenateChunks(decryptedChunks)

  // 6. Verify full file checksum
  const fileHash = await sha256(fullFile)
  if (base64Encode(fileHash) !== manifest.checksum) {
    throw new Error('File integrity check failed')
  }

  return new Blob([fullFile], { type: manifest.mimeType })
}

function concatenateChunks(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}
```

### Streaming for Large Files

For very large files (videos > 100MB), use streaming to avoid memory issues:

```typescript
async function streamDownloadAttachment(
  attachmentRef: AttachmentRef,
  vaultKey: Uint8Array
): Promise<ReadableStream<Uint8Array>> {
  // Fetch and decrypt manifest first
  const { manifest, fileKey } = await fetchManifestAndKey(attachmentRef, vaultKey)

  let chunkIndex = 0

  return new ReadableStream({
    async pull(controller) {
      if (chunkIndex >= manifest.chunks.length) {
        controller.close()
        return
      }

      const chunkRef = manifest.chunks[chunkIndex]
      const { encryptedData, nonce } = await api.getChunk(chunkRef.hash)

      const decrypted = await xchacha20poly1305Decrypt(
        fileKey,
        base64Decode(nonce),
        encryptedData
      )

      // Verify chunk
      const computedHash = await sha256(decrypted)
      if (base64Encode(computedHash) !== chunkRef.hash) {
        controller.error(new Error(`Chunk ${chunkIndex} integrity failed`))
        return
      }

      controller.enqueue(decrypted)
      chunkIndex++
    }
  })
}

// Usage: Stream video to player or save to disk
async function playVideo(attachmentRef: AttachmentRef, vaultKey: Uint8Array) {
  const stream = await streamDownloadAttachment(attachmentRef, vaultKey)
  const response = new Response(stream, {
    headers: { 'Content-Type': attachmentRef.mimeType }
  })
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  videoElement.src = url
}
```

### Resumable Uploads

```typescript
interface UploadSession {
  id: string
  manifestId: string
  filename: string
  totalChunks: number
  uploadedChunks: number[]     // Indices of completed chunks
  encryptedFileKey: string     // Encrypted with vault key for resumption
  keyNonce: string
  createdAt: number
  expiresAt: number            // Sessions expire after 7 days
}

async function createUploadSession(
  file: File,
  vaultKey: Uint8Array
): Promise<UploadSession> {
  const fileKey = crypto.getRandomValues(new Uint8Array(32))
  const keyNonce = crypto.getRandomValues(new Uint8Array(24))
  const encryptedFileKey = await xchacha20poly1305Encrypt(vaultKey, keyNonce, fileKey)

  const session: UploadSession = {
    id: crypto.randomUUID(),
    manifestId: crypto.randomUUID(),
    filename: file.name,
    totalChunks: Math.ceil(file.size / CHUNK_SIZE),
    uploadedChunks: [],
    encryptedFileKey: base64Encode(encryptedFileKey),
    keyNonce: base64Encode(keyNonce),
    createdAt: Date.now(),
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000  // 7 days
  }

  await saveUploadSession(session)
  return session
}

async function resumeUpload(
  sessionId: string,
  file: File,
  vaultKey: Uint8Array,
  onProgress: (progress: number) => void
): Promise<AttachmentRef> {
  const session = await getUploadSession(sessionId)

  if (Date.now() > session.expiresAt) {
    await deleteUploadSession(sessionId)
    throw new Error('Upload session expired')
  }

  // Decrypt file key from session
  const fileKey = await xchacha20poly1305Decrypt(
    vaultKey,
    base64Decode(session.keyNonce),
    base64Decode(session.encryptedFileKey)
  )

  // Find missing chunks
  const allChunks = Array.from({ length: session.totalChunks }, (_, i) => i)
  const missingChunks = allChunks.filter(i => !session.uploadedChunks.includes(i))

  const chunks: ChunkRef[] = []

  // Upload only missing chunks
  for (const i of missingChunks) {
    const start = i * CHUNK_SIZE
    const end = Math.min(start + CHUNK_SIZE, file.size)
    const chunkData = await file.slice(start, end).arrayBuffer()

    const contentHash = await sha256(new Uint8Array(chunkData))
    const nonce = crypto.getRandomValues(new Uint8Array(24))
    const encryptedData = await xchacha20poly1305Encrypt(
      fileKey,
      nonce,
      new Uint8Array(chunkData)
    )
    const encryptedHash = await sha256(encryptedData)

    await api.uploadChunk({
      hash: base64Encode(contentHash),
      encryptedHash: base64Encode(encryptedHash),
      encryptedData,
      nonce: base64Encode(nonce)
    })

    chunks[i] = {
      index: i,
      hash: base64Encode(contentHash),
      encryptedHash: base64Encode(encryptedHash),
      size: end - start
    }

    // Update session progress
    session.uploadedChunks.push(i)
    await saveUploadSession(session)

    onProgress(session.uploadedChunks.length / session.totalChunks)
  }

  // Finalize upload
  const attachment = await finalizeUpload(session, file, fileKey, vaultKey, chunks)
  await deleteUploadSession(sessionId)

  return attachment
}
```

### Thumbnail Generation

```typescript
async function generateThumbnail(file: File): Promise<string | undefined> {
  const maxSize = 200  // px

  try {
    if (file.type.startsWith('image/')) {
      return await generateImageThumbnail(file, maxSize)
    }

    if (file.type === 'application/pdf') {
      return await generatePdfThumbnail(file, maxSize)
    }

    if (file.type.startsWith('video/')) {
      return await generateVideoThumbnail(file, maxSize)
    }

    // No thumbnail for audio, archives, etc.
    return undefined
  } catch (error) {
    console.warn('Failed to generate thumbnail:', error)
    return undefined
  }
}

async function generateImageThumbnail(file: File, maxSize: number): Promise<string> {
  const img = await createImageBitmap(file)
  const scale = Math.min(maxSize / img.width, maxSize / img.height, 1)

  const canvas = new OffscreenCanvas(
    Math.round(img.width * scale),
    Math.round(img.height * scale)
  )
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)

  const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.7 })
  return blobToBase64(blob)
}

async function generatePdfThumbnail(file: File, maxSize: number): Promise<string> {
  // Using pdf.js
  const pdfjsLib = await import('pdfjs-dist')
  const pdf = await pdfjsLib.getDocument(await file.arrayBuffer()).promise
  const page = await pdf.getPage(1)

  const viewport = page.getViewport({ scale: 1 })
  const scale = Math.min(maxSize / viewport.width, maxSize / viewport.height, 1)
  const scaledViewport = page.getViewport({ scale })

  const canvas = new OffscreenCanvas(
    Math.round(scaledViewport.width),
    Math.round(scaledViewport.height)
  )
  await page.render({
    canvasContext: canvas.getContext('2d')!,
    viewport: scaledViewport
  }).promise

  const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.7 })
  return blobToBase64(blob)
}

async function generateVideoThumbnail(file: File, maxSize: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.muted = true

    video.onloadedmetadata = () => {
      // Seek to 1 second or 10% of video, whichever is smaller
      video.currentTime = Math.min(1, video.duration * 0.1)
    }

    video.onseeked = async () => {
      const scale = Math.min(maxSize / video.videoWidth, maxSize / video.videoHeight, 1)
      const canvas = new OffscreenCanvas(
        Math.round(video.videoWidth * scale),
        Math.round(video.videoHeight * scale)
      )
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)

      const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.7 })
      URL.revokeObjectURL(video.src)
      resolve(await blobToBase64(blob))
    }

    video.onerror = () => {
      URL.revokeObjectURL(video.src)
      reject(new Error('Failed to load video'))
    }

    video.src = URL.createObjectURL(file)
  })
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return `data:${blob.type};base64,${btoa(binary)}`
}
```

### Deduplication Benefits

Content-addressable chunks enable automatic deduplication:

```
Scenario 1: Same file attached to multiple notes
─────────────────────────────────────────────────
User uploads 50MB PDF to Note A
  → 7 chunks uploaded: hash_a, hash_b, hash_c, hash_d, hash_e, hash_f, hash_g
  → Storage used: 50MB

User attaches SAME PDF to Note B
  → Server: "All 7 chunks already exist"
  → Only new manifest uploaded (< 1KB)
  → Additional storage: ~1KB (not 50MB!)

Scenario 2: Similar files (e.g., document revisions)
─────────────────────────────────────────────────
User uploads report_v1.pdf (50MB)
  → 7 chunks uploaded

User uploads report_v2.pdf (52MB, 90% same content)
  → 6 chunks already exist (dedup!)
  → Only 2 new chunks uploaded (~10MB)
  → Storage: 60MB total (not 102MB)
```

### Supported File Types

| Type | Extensions | Thumbnail | Notes |
|------|------------|-----------|-------|
| Images | jpg, png, webp, gif, svg | Yes | Full preview support |
| Documents | pdf | Yes (first page) | Rendered via pdf.js |
| Video | mp4, mov, webm, mkv | Yes (frame at 1s) | Streaming playback |
| Audio | mp3, wav, m4a, ogg, flac | No | Waveform visualization possible |
| Archives | zip, tar, gz, 7z | No | List contents locally |
| Other | * | No | Download only |

### Performance Targets

| Operation | File Size | Target |
|-----------|-----------|--------|
| Upload small file | < 8MB | < 3 seconds |
| Upload medium file | 8-50MB | < 30 seconds |
| Upload large file | 50-500MB | < 3 minutes |
| Download small file | < 8MB | < 2 seconds |
| Download medium file | 8-50MB | < 20 seconds |
| Stream video start | Any | < 5 seconds to first frame |
| Thumbnail generation | Any | < 1 second |

### Acceptance Criteria (Attachments)

- [ ] Files split into 8MB chunks
- [ ] Each chunk encrypted with file key
- [ ] Content-addressable storage (SHA-256 hash)
- [ ] Deduplication works (same chunk not re-uploaded)
- [ ] Resumable uploads (session persists)
- [ ] Progress indicator shows upload/download %
- [ ] Thumbnails generated for images/PDF/video
- [ ] Streaming download for large files
- [ ] Integrity verification (chunk + file hash)
- [ ] Failed chunk upload retries automatically

---

## KEY ROTATION

When user wants to rotate keys (security best practice, or after device compromise):

```typescript
async function rotateVaultKey(): Promise<void> {
  const oldMasterKey = await keychain.get('memry-master-key')
  const oldVaultKey = deriveVaultKey(oldMasterKey)

  // Generate new master key (requires new recovery phrase)
  const newRecoveryPhrase = generateRecoveryPhrase()
  const newSalt = crypto.getRandomValues(new Uint8Array(32))
  const newMasterKey = await deriveMasterKey(newRecoveryPhrase, newSalt)
  const newVaultKey = deriveVaultKey(newMasterKey)

  // Re-encrypt all file keys with new vault key
  // Note: We don't re-encrypt content, just the file keys
  const allItems = await getAllEncryptedItems()

  for (const item of allItems) {
    // Decrypt file key with old vault key
    const fileKey = await xchacha20poly1305Decrypt(
      oldVaultKey,
      base64Decode(item.keyNonce),
      base64Decode(item.encryptedKey)
    )

    // Re-encrypt file key with new vault key
    const newKeyNonce = crypto.getRandomValues(new Uint8Array(24))
    const newEncryptedKey = await xchacha20poly1305Encrypt(
      newVaultKey,
      newKeyNonce,
      fileKey
    )

    // Update item (content stays encrypted with same file key)
    await updateItemKey(item.id, {
      encryptedKey: base64Encode(newEncryptedKey),
      keyNonce: base64Encode(newKeyNonce)
    })
  }

  // Update server with new encrypted salt
  const encryptedSalt = await encrypt(newSalt, newVaultKey)
  await api.post('/account/rotate-key', {
    encryptedSalt: base64Encode(encryptedSalt),
    verificationHash: base64Encode(await hash(newMasterKey))
  })

  // Store new master key
  await keychain.set('memry-master-key', newMasterKey)

  // Return new recovery phrase (show to user ONCE)
  return { newRecoveryPhrase }
}
```

---

## COLLABORATION (Future)

With CRDTs in place, collaboration requires minimal additions:

### Sharing a Note

```typescript
interface SharePermission {
  noteId: string
  userId: string
  permission: 'read' | 'write' | 'admin'
  encryptedFileKey: string  // File key encrypted for recipient's public key
  sharedAt: number
  sharedBy: string
}

async function shareNote(
  noteId: string,
  recipientUserId: string,
  permission: 'read' | 'write'
): Promise<void> {
  // Get recipient's public key from server
  const { publicKey: recipientPublicKey } = await api.get(`/users/${recipientUserId}/public-key`)

  // Get file key for this note
  const fileKey = await getFileKey(noteId)

  // Encrypt file key for recipient using their public key
  const encryptedForRecipient = await sealBox(
    fileKey,
    base64Decode(recipientPublicKey)
  )

  // Store share on server
  await api.post(`/notes/${noteId}/shares`, {
    recipientUserId,
    permission,
    encryptedFileKey: base64Encode(encryptedForRecipient)
  })
}

// Recipient accepts share
async function acceptShare(noteId: string): Promise<void> {
  // Get encrypted file key
  const share = await api.get(`/notes/${noteId}/my-share`)

  // Decrypt with our private key
  const fileKey = await openBox(
    base64Decode(share.encryptedFileKey),
    await getPrivateKey()
  )

  // Store file key locally
  await storeFileKey(noteId, fileKey)

  // Now we can sync this note
  await syncEngine.pullNote(noteId)
}
```

### Real-time Presence (Awareness)

```typescript
// Using Yjs awareness protocol for cursor positions
import { Awareness } from 'y-protocols/awareness'

interface UserPresence {
  user: {
    name: string
    color: string
  }
  cursor: {
    anchor: number
    head: number
  } | null
}

function setupPresence(doc: Y.Doc, noteId: string): Awareness {
  const awareness = new Awareness(doc)

  awareness.setLocalStateField('user', {
    name: getCurrentUserName(),
    color: getUserColor()
  })

  // Sync awareness through encrypted channel
  awareness.on('update', async ({ added, updated, removed }) => {
    const states = Array.from(awareness.getStates().entries())
    // Don't encrypt awareness - it's ephemeral
    // But authenticate it
    await syncApi.broadcastAwareness(noteId, states)
  })

  return awareness
}
```

---

## SECURITY CONSIDERATIONS

### Threat Model

| Threat | Mitigation |
|--------|------------|
| Server compromise | Zero-knowledge: server only has encrypted blobs |
| Network eavesdropping | TLS 1.3 for all connections |
| Man-in-the-middle | Certificate pinning + signature verification |
| Replay attacks | Nonces + timestamps + signatures |
| Device theft | Master key in OS keychain (biometric/PIN protected) |
| Lost recovery phrase | Cannot recover - this is a feature, not a bug |
| Malicious collaborator | Permission system + audit log |
| Server replay/drops | Merkle tree verification (future) |

### What Server Can See (Metadata)

Even with E2EE, server observes:
- Item IDs (UUIDs, meaningless)
- Number of items per type
- Size of encrypted blobs
- Timing of changes
- Which devices are linked
- Which users share notes (but not content)

### Future: Metadata Privacy

- Pad encrypted content to fixed size buckets
- Add timing jitter to sync
- Use PIR (Private Information Retrieval) for queries
- Encrypted item IDs (requires more complex protocol)

---

## NON-FUNCTIONAL REQUIREMENTS

### Performance

| Operation | Target |
|-----------|--------|
| Single item sync | < 2 seconds |
| Batch 100 items | < 30 seconds |
| Initial sync (1000 items) | < 5 minutes |
| Note update (Yjs) | < 100ms local, < 500ms synced |
| UI responsiveness during sync | Never blocked |

### Reliability

- Sync queue persists across crashes (IndexedDB)
- Failed syncs retry with exponential backoff (max 60s)
- Network interruption never corrupts data
- Partial sync is resumable
- CRDTs ensure eventual consistency

### Security

- Keys never transmitted unencrypted
- Keys never logged or in error reports
- All content signed for authenticity
- TLS 1.3 minimum
- Certificate pinning on mobile

---

## ACCEPTANCE CRITERIA

### First Device Setup

- [ ] OAuth signup works (Google, Apple, GitHub)
- [ ] Recovery phrase (24 words) displayed clearly
- [ ] Recovery phrase confirmation required before proceeding
- [ ] Master key derived from recovery phrase (not random)
- [ ] Master key stored in OS keychain
- [ ] Salt generated and encrypted on server
- [ ] Sync begins automatically after setup

### Device Linking (QR Code)

- [ ] Existing device generates QR with ephemeral ECDH key
- [ ] QR expires after 5 minutes
- [ ] New device scans and computes shared secret
- [ ] Existing device approval required
- [ ] Master key transferred via ECDH shared secret
- [ ] Linked device appears in device list

### Device Linking (Recovery Phrase)

- [ ] 24 words entered correctly restores access
- [ ] Wrong phrase shows clear error
- [ ] Device registered on successful restore

### Push Sync

- [ ] Local note edit triggers Yjs update sync
- [ ] Local task change triggers vector clock sync
- [ ] Offline changes queue in IndexedDB
- [ ] Coming online flushes queue automatically
- [ ] Sync errors show retry option

### Pull Sync

- [ ] Yjs updates from other devices merge automatically
- [ ] Task changes from other devices merge by field
- [ ] Deletes propagate to all devices
- [ ] Large attachments sync in background

### Conflict Resolution

- [ ] Notes: Yjs merges all edits (no conflicts)
- [ ] Tasks: Field-level LWW by vector clock
- [ ] Concurrent offline edits merge correctly

### Security

- [ ] Server logs show only encrypted blobs
- [ ] All encrypted items have valid signatures
- [ ] Invalid signatures are rejected
- [ ] Recovery phrase never stored after setup
- [ ] Key rotation re-encrypts file keys
- [ ] Device removal revokes access

### Status & UI

- [ ] Sync icon shows current status
- [ ] "Syncing..." with item count during sync
- [ ] Error state shows message and retry button
- [ ] Offline state shows pending queue count
- [ ] Sync history viewable in settings

### Collaboration (Future)

- [ ] Can share note with another user
- [ ] Shared note syncs for both users
- [ ] Permission levels enforced (read/write)
- [ ] Real-time cursors visible
- [ ] Revoking share removes access
