# Quickstart: Sync Engine & E2EE

**Feature**: 001-sync-e2ee-2 | **Date**: 2026-01-14

This guide helps developers get started with implementing the sync and E2EE system.

## Prerequisites

### Required Tools

```bash
# Node.js 20+
node --version  # v20.x or higher

# pnpm (package manager)
npm install -g pnpm

# Wrangler CLI (for Cloudflare Workers)
pnpm add -g wrangler
```

### Required Accounts

- **Cloudflare Account**: For Workers, D1, R2
- **OAuth App Credentials**: Google, Apple, GitHub (optional if only using email auth)
- **Email Service**: For verification emails (Resend, SendGrid, or Cloudflare Email)

## Project Setup

### 1. Install New Dependencies

```bash
# Client-side crypto
pnpm add libsodium-wrappers keytar bip39

# Canonical CBOR for signatures/HMAC
pnpm add cborg

# For main process (faster native bindings)
pnpm add sodium-native

# CRDTs (main process persistence)
pnpm add yjs y-protocols y-leveldb level

# QR code generation/scanning
pnpm add qrcode @capacitor/barcode-scanner  # or react-qr-reader for web
```

### 2. Create Sync Server Project

```bash
# From repo root
mkdir sync-server
cd sync-server

# Initialize Cloudflare Workers project
pnpm create cloudflare@latest . -- --template hono

# Add dependencies
pnpm add hono @hono/zod-validator zod jose
pnpm add cborg
pnpm add -D @cloudflare/workers-types wrangler
```

### 3. Configure Cloudflare Resources

```bash
# Login to Cloudflare
wrangler login

# Create D1 database
wrangler d1 create memry-sync

# Create R2 bucket
wrangler r2 bucket create memry-blobs

# Update wrangler.toml with bindings
```

## Directory Structure

Create these new directories in the Electron app:

```bash
# Main process modules
mkdir -p src/main/crypto
mkdir -p src/main/sync

# Renderer modules
mkdir -p src/renderer/src/contexts
mkdir -p src/renderer/src/components/sync

# Shared contracts
mkdir -p src/shared/contracts
```

## Key Implementation Files

### Crypto Module Entry Point

```typescript
// src/main/crypto/index.ts
export { deriveKeys, generateRecoveryPhrase, validateRecoveryPhrase } from './keys'
export { encrypt, decrypt } from './encryption'
export { sign, verify } from './signatures'
export { getFromKeychain, saveToKeychain } from './keychain'
```

### Sync Engine Entry Point

```typescript
// src/main/sync/index.ts
export { SyncEngine } from './engine'
export { SyncQueue } from './queue'
export { MemrySyncProvider } from './crdt-provider'
export { AttachmentSync } from './attachments'
```

### IPC Handler Registration

```typescript
// src/main/ipc/sync-handlers.ts
import { ipcMain } from 'electron'
import { createValidatedHandler } from './validate'
import * as syncSchemas from '@shared/contracts/sync-api'

export function registerSyncHandlers() {
  // Setup
  ipcMain.handle('sync:setup-first-device', createValidatedHandler(
    syncSchemas.SetupFirstDeviceSchema,
    handleSetupFirstDevice
  ))

  // Status
  ipcMain.handle('sync:get-status', handleGetSyncStatus)
  ipcMain.handle('sync:trigger-sync', handleTriggerSync)

  // Devices
  ipcMain.handle('sync:get-devices', handleGetDevices)
  ipcMain.handle('sync:remove-device', handleRemoveDevice)

  // Linking
  ipcMain.handle('sync:generate-linking-qr', handleGenerateLinkingQR)
  ipcMain.handle('sync:link-via-qr', handleLinkViaQR)
  ipcMain.handle('sync:approve-linking', handleApproveLinking)
}
```

## First Implementation Steps

### Step 1: Crypto Utilities (1-2 days)

Start with the crypto module as it's foundational:

```typescript
// src/main/crypto/keys.ts
import sodium from 'sodium-native'
import * as bip39 from 'bip39'

const ARGON2_PARAMS = {
  memoryCost: 65536,  // 64 MB
  timeCost: 3,
  parallelism: 4,
  hashLength: 32
}

export function generateRecoveryPhrase(): string {
  return bip39.generateMnemonic(256) // 24 words
}

export function validateRecoveryPhrase(phrase: string): boolean {
  return bip39.validateMnemonic(phrase)
}

export async function deriveKeys(phrase: string, kdfSalt: Uint8Array) {
  const seed = await bip39.mnemonicToSeed(phrase)

  // Derive master key with Argon2id
  const masterKey = Buffer.alloc(32)
  sodium.crypto_pwhash(
    masterKey,
    Buffer.from(seed),
    kdfSalt,
    ARGON2_PARAMS.timeCost,
    ARGON2_PARAMS.memoryCost * 1024,
    sodium.crypto_pwhash_ALG_ARGON2ID13
  )

  // Derive purpose-specific keys with HKDF
  const vaultKey = hkdfDerive(masterKey, 'vault-key')
  const signingKey = hkdfDerive(masterKey, 'signing-key')
  const verifyKey = hkdfDerive(masterKey, 'verify-key')
  const keyVerifier = hmacSha256(verifyKey, 'memry-key-verify-v1')

  return { masterKey, vaultKey, signingKey, verifyKey, keyVerifier }
}
```

Store `kdf_salt` (plaintext) and `key_verifier` (HMAC) on the server during first device
setup so new devices can derive and validate the master key without circular dependencies.

Use canonical CBOR (RFC 8949) when creating signature/HMAC payloads to ensure deterministic
encoding across platforms.

### Step 2: Keychain Integration (0.5 day)

```typescript
// src/main/crypto/keychain.ts
import keytar from 'keytar'

const SERVICE_NAME = 'memry'

export async function saveToKeychain(key: string, value: string): Promise<void> {
  await keytar.setPassword(SERVICE_NAME, key, value)
}

export async function getFromKeychain(key: string): Promise<string | null> {
  return keytar.getPassword(SERVICE_NAME, key)
}

export async function deleteFromKeychain(key: string): Promise<boolean> {
  return keytar.deletePassword(SERVICE_NAME, key)
}

// Keys stored in keychain:
// - 'master-key': Base64 encoded master key
// - 'device-id': Current device UUID
// - 'user-id': User UUID
```

### Step 3: Encryption/Decryption (1 day)

```typescript
// src/main/crypto/encryption.ts
import sodium from 'sodium-native'

export interface EncryptResult {
  ciphertext: Buffer
  nonce: Buffer
}

export function encrypt(plaintext: Buffer, key: Buffer): EncryptResult {
  const nonce = Buffer.alloc(sodium.crypto_secretbox_NONCEBYTES)
  sodium.randombytes_buf(nonce)

  const ciphertext = Buffer.alloc(plaintext.length + sodium.crypto_secretbox_MACBYTES)
  sodium.crypto_secretbox_easy(ciphertext, plaintext, nonce, key)

  return { ciphertext, nonce }
}

export function decrypt(ciphertext: Buffer, nonce: Buffer, key: Buffer): Buffer {
  const plaintext = Buffer.alloc(ciphertext.length - sodium.crypto_secretbox_MACBYTES)

  const success = sodium.crypto_secretbox_open_easy(plaintext, ciphertext, nonce, key)
  if (!success) {
    throw new Error('Decryption failed - invalid ciphertext or key')
  }

  return plaintext
}
```

### Step 4: Sync Server Basics (2-3 days)

```typescript
// sync-server/src/index.ts
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { authRoutes } from './routes/auth'
import { syncRoutes } from './routes/sync'
import { blobRoutes } from './routes/blob'

type Bindings = {
  DB: D1Database
  BLOB_BUCKET: R2Bucket
  USER_STATE: DurableObjectNamespace
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('*', cors())

app.route('/auth', authRoutes)
app.route('/sync', syncRoutes)
app.route('/blob', blobRoutes)

export default app
```

## Testing Approach

### Unit Tests for Crypto

```typescript
// tests/unit/crypto/encryption.test.ts
import { describe, it, expect } from 'vitest'
import { encrypt, decrypt } from '@main/crypto/encryption'
import sodium from 'sodium-native'

describe('encryption', () => {
  it('encrypts and decrypts successfully', () => {
    const key = Buffer.alloc(32)
    sodium.randombytes_buf(key)

    const plaintext = Buffer.from('Hello, World!')
    const { ciphertext, nonce } = encrypt(plaintext, key)

    const decrypted = decrypt(ciphertext, nonce, key)
    expect(decrypted.toString()).toBe('Hello, World!')
  })

  it('fails with wrong key', () => {
    const key1 = Buffer.alloc(32)
    const key2 = Buffer.alloc(32)
    sodium.randombytes_buf(key1)
    sodium.randombytes_buf(key2)

    const plaintext = Buffer.from('Secret')
    const { ciphertext, nonce } = encrypt(plaintext, key1)

    expect(() => decrypt(ciphertext, nonce, key2)).toThrow()
  })

  it('produces different ciphertext for same plaintext', () => {
    const key = Buffer.alloc(32)
    sodium.randombytes_buf(key)

    const plaintext = Buffer.from('Same message')
    const result1 = encrypt(plaintext, key)
    const result2 = encrypt(plaintext, key)

    expect(result1.ciphertext).not.toEqual(result2.ciphertext)
  })
})
```

### Integration Test for Sync Queue

```typescript
// tests/integration/sync-queue.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SyncQueue } from '@main/sync/queue'

describe('SyncQueue', () => {
  let queue: SyncQueue

  beforeEach(async () => {
    queue = new SyncQueue(':memory:')
    await queue.init()
  })

  afterEach(async () => {
    await queue.close()
  })

  it('persists items across restarts', async () => {
    await queue.enqueue({
      type: 'task',
      itemId: 'task-123',
      operation: 'update',
      payload: 'encrypted-data'
    })

    // Simulate restart
    await queue.close()
    queue = new SyncQueue(':memory:')
    await queue.init()

    const pending = await queue.getPending()
    expect(pending).toHaveLength(1)
    expect(pending[0].itemId).toBe('task-123')
  })
})
```

## Environment Variables

### Client (Electron)

```bash
# .env.development
SYNC_SERVER_URL=http://localhost:8787
OAUTH_GOOGLE_CLIENT_ID=xxx
OAUTH_APPLE_CLIENT_ID=xxx
OAUTH_GITHUB_CLIENT_ID=xxx
```

### Server (Cloudflare Workers)

```toml
# sync-server/wrangler.toml
[vars]
ENVIRONMENT = "development"

[env.production.vars]
ENVIRONMENT = "production"

# Secrets (set via wrangler secret put)
# OAUTH_GOOGLE_CLIENT_SECRET
# OAUTH_APPLE_CLIENT_SECRET
# OAUTH_GITHUB_CLIENT_SECRET
# JWT_SECRET
```

## Common Gotchas

### 1. Native Module Rebuilding

After installing `sodium-native` or `keytar`, rebuild for Electron:

```bash
pnpm rebuild
# or
./node_modules/.bin/electron-rebuild
```

### 2. libsodium Async Ready

Always wait for libsodium to be ready in renderer:

```typescript
import _sodium from 'libsodium-wrappers'

async function init() {
  await _sodium.ready
  // Now safe to use _sodium
}
```

### 3. Keychain Permissions (macOS)

On macOS, the app needs keychain access. Add to `entitlements.mac.plist`:

```xml
<key>keychain-access-groups</key>
<array>
  <string>$(AppIdentifierPrefix)com.memry.app</string>
</array>
```

### 4. IPC Serialization

IPC can't transfer Buffers directly. Convert to Base64:

```typescript
// Main process
const encrypted = encrypt(data, key)
return {
  ciphertext: encrypted.ciphertext.toString('base64'),
  nonce: encrypted.nonce.toString('base64')
}

// Renderer process
const result = await window.api.encrypt(data)
const ciphertext = Buffer.from(result.ciphertext, 'base64')
```

## Next Steps

1. Complete Phase 1 (Crypto) implementation
2. Write comprehensive unit tests for all crypto functions
3. Set up Cloudflare Workers dev environment
4. Implement OAuth flows
5. Begin sync queue implementation

Refer to:
- [plan.md](./plan.md) - Full implementation phases
- [research.md](./research.md) - Technology decisions
- [data-model.md](./data-model.md) - Entity schemas
- [contracts/](./contracts/) - API specifications
