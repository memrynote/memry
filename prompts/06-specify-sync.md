# Sync Engine & E2E Encryption Specification

Secure synchronization between devices via encrypted central server.

```
/speckit.specify

Build the sync engine that synchronizes encrypted data between devices:

## USER STORIES

### P1 - Critical
1. As a user, I want my data synced across desktop and mobile so I see the same content everywhere
2. As a user, I want my data encrypted before leaving my device so even the server can't read it
3. As a user, I want sync to work when I come back online after being offline
4. As a user, I want to see sync status clearly (syncing, synced, error)
5. As a user, I want to link new devices securely

### P2 - Important
6. As a user, I want conflicts handled automatically with a backup copy preserved
7. As a user, I want to see sync activity history
8. As a user, I want to force sync manually if needed
9. As a user, I want to exclude certain items from sync (local-only notes)
10. As a user, I want sync to work in background without blocking my work

### P3 - Nice to Have
11. As a user, I want selective sync (choose what to sync on mobile)
12. As a user, I want to see how much data is being used
13. As a user, I want sync pause option for metered connections
14. As a user, I want to remove a device from my account

## CRYPTOGRAPHIC DESIGN

### Key Hierarchy
Recovery Key (24 words BIP39)
        │
        └──► Master Key (256-bit, derived via Argon2id)
                │
                ├──► Vault Key (derived, encrypts vault data)
                │
                ├──► File Keys (random per file, encrypted with Vault Key)
                │
                └──► Device Keys (derived per device for device auth)


### Encryption Scheme
```typescript
// Content encryption (per file)
interface EncryptedItem {
  id: string                    // UUID (unencrypted)
  encryptedKey: string          // File key encrypted with Vault Key (base64)
  encryptedData: string         // Content encrypted with File Key (base64)
  nonce: string                 // Unique per encryption (base64)
  version: number               // For conflict detection
  modifiedAt: Date              // Server timestamp
}

// Encryption process
function encryptItem(item: PlainItem, vaultKey: Uint8Array): EncryptedItem {
  // 1. Generate random file key
  const fileKey = crypto.getRandomValues(new Uint8Array(32))

  // 2. Encrypt content with file key (AES-256-GCM)
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const plaintext = JSON.stringify(item.content)
  const encryptedData = aesGcmEncrypt(fileKey, nonce, plaintext)

  // 3. Encrypt file key with vault key
  const keyNonce = crypto.getRandomValues(new Uint8Array(12))
  const encryptedKey = aesGcmEncrypt(vaultKey, keyNonce, fileKey)

  return {
    id: item.id,
    encryptedKey: base64Encode(encryptedKey),
    encryptedData: base64Encode(encryptedData),
    nonce: base64Encode(nonce),
    version: item.version + 1,
    modifiedAt: new Date()
  }
}
```

### Key Derivation
```typescript
// From recovery phrase to master key
async function deriveMainKey(recoveryPhrase: string, salt: Uint8Array): Promise<Uint8Array> {
  // Convert mnemonic to seed (BIP39)
  const seed = mnemonicToSeed(recoveryPhrase)

  // Derive master key with Argon2id
  const masterKey = await argon2id({
    password: seed,
    salt: salt,
    parallelism: 4,
    iterations: 3,
    memorySize: 65536,
    hashLength: 32
  })

  return masterKey
}

// Derive vault key from master key
function deriveVaultKey(masterKey: Uint8Array): Uint8Array {
  return hkdf(masterKey, "memry-vault-key", 32)
}
```

## FUNCTIONAL REQUIREMENTS

### First Device Setup
```
1. User signs up (OAuth: Google/Apple/GitHub)
2. Generate random master key (256 bits)
3. Generate recovery phrase (BIP39 24 words)
4. Show recovery phrase, require confirmation
5. Store master key in OS keychain
6. Generate salt, store encrypted with master key on server
7. User is now set up for sync
```

### Device Linking
```
Option A: QR Code (Recommended)
1. New device: Click "Link existing account"
2. New device: Sign in with OAuth
3. Existing device: Go to Settings > Devices > Link New Device
4. Existing device: Display QR code containing:
   - Encrypted master key (encrypted with temporary code)
   - One-time linking token
5. New device: Scan QR code
6. New device: Decrypt master key, store in keychain
7. Server: Mark device as linked

Option B: Recovery Phrase
1. New device: Click "Restore from recovery phrase"
2. New device: Sign in with OAuth
3. New device: Enter 24-word recovery phrase
4. New device: Derive master key, store in keychain
5. Fetch salt from server, verify key is correct
```

### Sync Protocol
```
PUSH (Local changes → Server)
1. Detect local changes (file save, task update, etc.)
2. Add to sync queue (persist queue in IndexedDB)
3. For each queued item:
   a. Encrypt item with current vault key
   b. POST to server with item ID and local version
   c. If conflict (server version newer):
      - Fetch server version
      - Create conflict copy locally
      - Retry push
   d. On success: update local version, remove from queue
4. Update sync status UI

PULL (Server changes → Local)
1. Connect to server (WebSocket or polling)
2. Receive change notifications with item IDs
3. For each changed item:
   a. Fetch encrypted data from server
   b. Decrypt with vault key
   c. Compare with local version
   d. If local is newer: queue push (conflict)
   e. If server is newer: apply locally
4. Update sync status UI
```

### Conflict Resolution
```
When same item modified on multiple devices:

1. Detect: local.version != remote.version && both changed

2. Resolve:
   a. Server version wins (becomes current)
   b. Local version saved as conflict copy:
      - Notes: filename.conflict-YYYY-MM-DD.md
      - Tasks: task appears twice with "(Conflict)" suffix
   c. User notification: "1 conflict resolved, review needed"

3. User review:
   a. See conflicts in sync panel
   b. View both versions side-by-side
   c. Choose: keep server, keep local, merge manually
   d. Delete losing version
```

### What Gets Synced
```
SYNCED (encrypted):
├── Notes (content + frontmatter)
├── Journal entries
├── Tasks + Projects + Statuses
├── Inbox items
├── Attachments (images, voice recordings)
└── Settings (theme, preferences)

NOT SYNCED (local only):
├── index.db (cache, rebuilt from synced data)
├── FTS search index (rebuilt locally)
├── UI state (window size, panel positions)
├── Sync queue (local bookkeeping)
└── Temp files
```

### Sync Status
```typescript
type SyncStatus =
  | { state: "idle", lastSync: Date }
  | { state: "syncing", itemsRemaining: number }
  | { state: "error", error: string, retryAt: Date }
  | { state: "offline", queueSize: number }
  | { state: "conflict", conflictCount: number }
```

## NON-FUNCTIONAL REQUIREMENTS

### Performance
- Sync single item in <2 seconds (on good connection)
- Batch sync 100 items in <30 seconds
- Initial sync of 1000 items in <5 minutes
- Background sync doesn't freeze UI (use Web Worker)

### Security
- Keys never transmitted unencrypted
- Keys never logged or included in error reports
- Server-side: only encrypted blobs stored
- TLS 1.3 for all network communication
- Replay attack prevention (nonces, timestamps)

### Reliability
- Sync queue persists across app crashes
- Failed syncs retry with exponential backoff
- Network interruption doesn't corrupt data
- Partial sync is resumable

## ACCEPTANCE CRITERIA

### First Device Setup
- [ ] OAuth signup works (Google, Apple, GitHub)
- [ ] Recovery phrase displayed clearly
- [ ] Recovery phrase confirmation required
- [ ] Master key stored in OS keychain
- [ ] Sync begins automatically after setup

### Device Linking
- [ ] QR code displays on existing device
- [ ] New device scans and links successfully
- [ ] Recovery phrase restore works
- [ ] Wrong recovery phrase shows error
- [ ] Linked device appears in device list

### Push Sync
- [ ] Local file save triggers sync within 5 seconds
- [ ] Task changes sync within 5 seconds
- [ ] Offline changes queue properly
- [ ] Coming online flushes queue
- [ ] Sync errors show retry option

### Pull Sync
- [ ] Changes from other devices appear automatically
- [ ] Delete on one device deletes everywhere
- [ ] Rename on one device updates everywhere
- [ ] Large attachments sync in background

### Conflicts
- [ ] Same file edited on two devices creates conflict copy
- [ ] Conflict notification appears
- [ ] Conflict review shows both versions
- [ ] Resolving conflict removes duplicate

### Security
- [ ] Server logs show only encrypted data
- [ ] Recovery phrase not stored anywhere after setup
- [ ] Removing device requires confirmation
- [ ] Key rotation possible (re-encrypt everything)

### Status & UI
- [ ] Sync icon shows current status
- [ ] "Syncing..." shows during active sync
- [ ] Error state shows clear message
- [ ] Offline state shows queue count
- [ ] Sync history viewable in settings
```
