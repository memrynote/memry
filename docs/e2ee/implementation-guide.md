# E2EE Sync Implementation Guide

> Last updated: January 2026
> Status: Phase 2 Complete (Foundation)

This document explains the End-to-End Encryption (E2EE) sync system implementation in Memry.

---

## Table of Contents

1. [Overview](#overview)
2. [What is CBOR?](#what-is-cbor)
3. [Key Hierarchy](#key-hierarchy)
4. [Encryption Flow](#encryption-flow)
5. [Signatures](#signatures)
6. [Vector Clocks](#vector-clocks)
7. [Implementation Status](#implementation-status)
8. [Code Reference](#code-reference)

---

## Overview

Memry uses **End-to-End Encryption (E2EE)** to ensure that:

- Your data is encrypted on your device before being sent to the server
- The server only sees encrypted blobs - it cannot read your notes
- Only your devices (with your keys) can decrypt your data
- Changes are signed to prevent tampering

### Core Technologies

| Technology         | Purpose                         |
| ------------------ | ------------------------------- |
| XChaCha20-Poly1305 | Authenticated encryption (AEAD) |
| Ed25519            | Digital signatures              |
| Argon2id           | Password/seed hashing           |
| HKDF               | Key derivation                  |
| BIP39              | Recovery phrase generation      |
| CBOR               | Canonical binary encoding       |

---

## What is CBOR?

### The Problem

When signing data, we need to convert JavaScript objects to bytes. But JavaScript objects are unordered:

```javascript
// These are "equal" in JavaScript, but might produce different bytes:
{ apple: 1, banana: 2 }
{ banana: 2, apple: 1 }
```

If we sign the first and verify with the second, **the signature fails** even though the data is identical.

### The Solution: Canonical CBOR

**CBOR** (Concise Binary Object Representation) is a binary format like JSON.

**Canonical CBOR** (RFC 8949, Section 4.2) adds strict ordering rules:

1. Sort map keys by **length** (shorter first)
2. Then sort **lexicographically** (alphabetically by bytes)

This ensures: **Same data → Same bytes → Same signature**

### The `canonicalMapSorter` Function

**Location**: `src/main/crypto/cbor.ts:17-38`

```typescript
function canonicalMapSorter(e1: (Token | Token[])[], e2: (Token | Token[])[]): number {
  const t1 = e1[0] as Token
  const t2 = e2[0] as Token

  // Get the key values for comparison
  const k1 = t1.value as string | number | Uint8Array
  const k2 = t2.value as string | number | Uint8Array

  // Convert to comparable buffers
  const b1 = typeof k1 === 'string' ? Buffer.from(k1) : Buffer.from(String(k1))
  const b2 = typeof k2 === 'string' ? Buffer.from(k2) : Buffer.from(String(k2))

  // RFC 8949: Sort by length first, then lexicographically
  if (b1.length !== b2.length) {
    return b1.length - b2.length
  }

  return b1.compare(b2)
}
```

**What it does:**

1. Takes two map entries (key-value pairs)
2. Extracts the keys
3. Converts keys to byte buffers
4. Compares by length first, then byte-by-byte

**Example ordering:**

```
"id"      (2 bytes) comes before
"type"    (4 bytes) comes before
"nonce"   (5 bytes) comes before
"version" (7 bytes)
```

### Usage

```typescript
import { canonicalEncode, createSignaturePayload } from '../crypto/cbor'

// Encode any data to canonical CBOR bytes
const bytes = canonicalEncode({ id: '123', type: 'note', data: 'hello' })

// Create a signature payload (for encrypted items)
const payload = createSignaturePayload({
  id: 'abc',
  type: 'note',
  cryptoVersion: 1,
  encryptedKey: '...',
  keyNonce: '...',
  encryptedData: '...',
  dataNonce: '...'
})
```

---

## Key Hierarchy

All cryptographic keys derive from a single root: the **recovery phrase**.

```
24-word Recovery Phrase
        │
        ▼
    [BIP39 PBKDF2]
        │
        ▼
    64-byte Seed
        │
        ▼
    [Argon2id] ◄─── KDF Salt (from server)
    (64MB RAM, 3 iterations)
        │
        ▼
    32-byte Master Key ─── stored in OS Keychain
        │
        ├──► [HKDF "memry-vault-key-v1"] ──► Vault Key (encrypts file keys)
        │
        ├──► [HKDF "memry-signing-key-v1"] ──► Signing Seed ──► Ed25519 Keypair
        │
        └──► [HKDF "memry-verify-key-v1"] ──► Verify Key ──► Key Verifier
```

### Key Derivation Code

**Location**: `src/main/crypto/keys.ts`

```typescript
// Derive master key from seed + salt
export function deriveMasterKey(seed: Buffer, salt: Buffer): Buffer {
  const masterKey = Buffer.alloc(32)
  sodium.crypto_pwhash(
    masterKey,
    seed,
    salt,
    3, // iterations (OWASP 2024)
    64 * 1024, // 64MB memory
    sodium.crypto_pwhash_ALG_ARGON2ID13
  )
  return masterKey
}

// Derive all keys from master key
export function deriveAllKeys(masterKey: Buffer): DerivedKeys {
  const vaultKey = deriveVaultKey(masterKey)
  const signingKeySeed = deriveSigningKeySeed(masterKey)
  const signingKeyPair = generateSigningKeyPair(signingKeySeed)
  const keyVerifier = computeKeyVerifier(masterKey)

  return {
    masterKey: new Uint8Array(masterKey),
    vaultKey: new Uint8Array(vaultKey),
    signingKeyPair: {
      publicKey: new Uint8Array(signingKeyPair.publicKey),
      secretKey: new Uint8Array(signingKeyPair.secretKey)
    },
    keyVerifier: new Uint8Array(keyVerifier)
  }
}
```

### Key Verifier

The **key verifier** proves you have the correct master key without revealing it:

```typescript
export function computeKeyVerifier(masterKey: Buffer): Buffer {
  const verifyKey = deriveVerifyKey(masterKey)
  const message = Buffer.from('memry-key-verify-v1', 'utf8')

  const verifier = Buffer.alloc(32)
  sodium.crypto_auth(verifier, message, verifyKey)

  return verifier
}
```

The server stores only the verifier. During recovery, we compute the verifier from the entered phrase and compare - if it matches, the phrase is correct.

---

## Encryption Flow

### Per-Item Encryption (Double Wrapping)

Each item (note, task, etc.) is encrypted with a **random file key**, which is then **wrapped** with the vault key:

```
Your Note: "Buy milk"
        │
        ▼
    [Generate random 32-byte File Key]
        │
        ├──► [XChaCha20-Poly1305] Encrypt "Buy milk" ──► encryptedData + dataNonce
        │
        └──► [XChaCha20-Poly1305] Wrap File Key with Vault Key ──► encryptedKey + keyNonce
        │
        ▼
    { encryptedData, dataNonce, encryptedKey, keyNonce, cryptoVersion }
```

**Why double-wrap?**

- Each item has a unique file key
- If one file key leaks, only that item is compromised
- Key rotation only needs to re-wrap file keys, not re-encrypt all data

### Encryption Code

**Location**: `src/main/crypto/encryption.ts:148-180`

```typescript
export function encryptItem(
  data: Buffer | string,
  vaultKey: Buffer
): {
  encryptedData: Buffer
  dataNonce: Buffer
  encryptedKey: Buffer
  keyNonce: Buffer
  cryptoVersion: number
} {
  const plaintext = typeof data === 'string' ? Buffer.from(data, 'utf8') : data

  // Generate random file key for this item
  const fileKey = generateFileKey()

  // Encrypt data with file key
  const { ciphertext: encryptedData, nonce: dataNonce } = encrypt(plaintext, fileKey)

  // Wrap file key with vault key
  const { ciphertext: encryptedKey, nonce: keyNonce } = wrapFileKey(fileKey, vaultKey)

  // IMPORTANT: Zero out file key from memory
  fileKey.fill(0)

  return {
    encryptedData: Buffer.from(encryptedData),
    dataNonce: Buffer.from(dataNonce),
    encryptedKey: Buffer.from(encryptedKey),
    keyNonce: Buffer.from(keyNonce),
    cryptoVersion: CRYPTO_VERSION
  }
}
```

### Decryption Code

**Location**: `src/main/crypto/encryption.ts:196-214`

```typescript
export function decryptItem(
  encryptedData: Buffer,
  dataNonce: Buffer,
  encryptedKey: Buffer,
  keyNonce: Buffer,
  vaultKey: Buffer
): Buffer {
  // Unwrap the file key
  const fileKey = unwrapFileKey(encryptedKey, keyNonce, vaultKey)

  try {
    // Decrypt the data
    const plaintext = decrypt(encryptedData, dataNonce, fileKey)
    return plaintext
  } finally {
    // Always zero out file key
    fileKey.fill(0)
  }
}
```

### Cryptographic Constants

| Constant         | Value    | Purpose                           |
| ---------------- | -------- | --------------------------------- |
| Key Length       | 32 bytes | XChaCha20-Poly1305 key            |
| Nonce Length     | 24 bytes | XChaCha20 nonce (safe for random) |
| Tag Length       | 16 bytes | Poly1305 auth tag                 |
| Signature Length | 64 bytes | Ed25519 signature                 |

---

## Signatures

### Why Sign?

Signatures prove:

1. **Authenticity**: This data came from you (not an attacker)
2. **Integrity**: Nobody modified the data in transit

### Signing Flow

```
Encrypted Item
        │
        ▼
    [Create CBOR Payload]
    (id, type, cryptoVersion, encryptedData, dataNonce, encryptedKey, keyNonce)
        │
        ▼
    [Ed25519 Sign with Secret Key]
        │
        ▼
    64-byte Signature
```

### Signature Code

**Location**: `src/main/crypto/signatures.ts:136-156`

```typescript
export function signItem(
  payload: {
    id: string
    type: string
    operation?: string
    cryptoVersion: number
    encryptedKey: string
    keyNonce: string
    encryptedData: string
    dataNonce: string
    metadata?: { clock?: VectorClock; fieldClocks?: Record<string, VectorClock> }
  },
  secretKey: Buffer
): Buffer {
  // Create canonical CBOR payload
  const message = createSignaturePayload(payload)

  // Sign with Ed25519
  return signRaw(message, secretKey)
}
```

### Verification Code

**Location**: `src/main/crypto/signatures.ts:173-191`

```typescript
export function verifyItem(
  signature: Buffer,
  payload: {
    /* same as above */
  },
  publicKey: Buffer
): boolean {
  const message = createSignaturePayload(payload)
  return verifyRaw(signature, message, publicKey)
}
```

---

## Vector Clocks

### What Are Vector Clocks?

Vector clocks track **causal relationships** between events across distributed systems (multiple devices).

Unlike wall-clock time (which can drift), vector clocks track **logical time**:

- "Device A made change #3"
- "Device B made change #2"
- "Device B saw Device A's change #1"

### Data Structure

```typescript
interface VectorClock {
  [deviceId: string]: number
}

// Example:
const clock = {
  'device-abc': 3, // Device ABC made 3 changes
  'device-xyz': 2 // Device XYZ made 2 changes
}
```

### Operations

**Location**: `src/main/sync/vector-clock.ts`

```typescript
// Create empty clock
export function createClock(): VectorClock {
  return {}
}

// Increment after local change
export function incrementClock(clock: VectorClock, deviceId: string): VectorClock {
  return {
    ...clock,
    [deviceId]: (clock[deviceId] ?? 0) + 1
  }
}

// Merge two clocks (take maximum of each device)
export function mergeClock(a: VectorClock, b: VectorClock): VectorClock {
  const merged: VectorClock = { ...a }
  for (const [device, time] of Object.entries(b)) {
    merged[device] = Math.max(merged[device] ?? 0, time)
  }
  return merged
}
```

### Comparing Clocks (Conflict Detection)

```typescript
export enum ClockComparison {
  BEFORE = -1, // A happened before B
  AFTER = 1, // A happened after B
  CONCURRENT = 0, // Conflict! Neither knows about the other
  EQUAL = 2 // Same state
}

export function compareClock(a: VectorClock, b: VectorClock): ClockComparison {
  const allDevices = new Set([...Object.keys(a), ...Object.keys(b)])

  let aLessOrEqual = true
  let bLessOrEqual = true

  for (const device of allDevices) {
    const timeA = a[device] ?? 0
    const timeB = b[device] ?? 0

    if (timeA > timeB) bLessOrEqual = false
    if (timeB > timeA) aLessOrEqual = false
  }

  if (aLessOrEqual && bLessOrEqual) return ClockComparison.EQUAL
  if (aLessOrEqual) return ClockComparison.BEFORE
  if (bLessOrEqual) return ClockComparison.AFTER
  return ClockComparison.CONCURRENT // Conflict!
}
```

### Example: Conflict Detection

```typescript
// Device A: made 3 changes, saw B at 1
const clockA = { 'device-A': 3, 'device-B': 1 }

// Device B: made 2 changes, saw A at 2
const clockB = { 'device-A': 2, 'device-B': 2 }

compareClock(clockA, clockB)
// Returns: CONCURRENT
// Why? A is ahead on 'device-A' (3 > 2), B is ahead on 'device-B' (2 > 1)
// Neither "happened before" the other - they diverged!
```

---

## Implementation Status

### Phase 1: Setup ✅ Complete

- Installed dependencies (libsodium, keytar, bip39, cborg)
- Created directory structure
- Set up Cloudflare Workers server skeleton
- Defined TypeScript contracts

### Phase 2: Foundation ✅ Complete

| Component        | Status | Location                          |
| ---------------- | ------ | --------------------------------- |
| CBOR encoding    | ✅     | `src/main/crypto/cbor.ts`         |
| Key derivation   | ✅     | `src/main/crypto/keys.ts`         |
| Encryption       | ✅     | `src/main/crypto/encryption.ts`   |
| Signatures       | ✅     | `src/main/crypto/signatures.ts`   |
| Keychain         | ✅     | `src/main/crypto/keychain.ts`     |
| Recovery phrases | ✅     | `src/main/crypto/recovery.ts`     |
| Vector clocks    | ✅     | `src/main/sync/vector-clock.ts`   |
| IPC handlers     | ✅     | `src/main/ipc/crypto-handlers.ts` |
| Preload bridge   | ✅     | `src/preload/index.ts`            |

### Phase 3+: Not Yet Implemented

| Phase    | Description                           | Status |
| -------- | ------------------------------------- | ------ |
| Phase 3  | User Story 1: First Device Setup      | TODO   |
| Phase 4  | User Story 2: Cross-Device Sync       | TODO   |
| Phase 5  | User Story 3: QR Device Linking       | TODO   |
| Phase 6  | User Story 4: Recovery Phrase Linking | TODO   |
| Phase 7  | User Story 5: CRDT Note Merging       | TODO   |
| Phase 8+ | Advanced features                     | TODO   |

---

## Code Reference

### File Locations

```
src/main/crypto/
├── cbor.ts          # Canonical CBOR encoding
├── encryption.ts    # XChaCha20-Poly1305 encryption
├── index.ts         # Module exports
├── keychain.ts      # OS keychain integration
├── keys.ts          # Key derivation (HKDF, Argon2id)
├── recovery.ts      # BIP39 recovery phrases
└── signatures.ts    # Ed25519 signing

src/main/sync/
├── index.ts         # Module exports
└── vector-clock.ts  # Vector clock implementation

src/main/ipc/
├── crypto-handlers.ts  # Crypto IPC handlers
└── sync-handlers.ts    # Sync IPC handlers

src/shared/contracts/
├── crypto.ts        # Crypto type definitions
├── ipc-sync.ts      # IPC channel definitions
└── sync-api.ts      # Sync API types
```

### IPC Usage (Renderer)

```typescript
// Generate recovery phrase
const { phrase } = await window.api.crypto.generateRecoveryPhrase()

// Validate recovery phrase
const result = await window.api.crypto.validateRecoveryPhrase(phrase)

// Encrypt an item
const encrypted = await window.api.crypto.encryptItem({
  data: JSON.stringify({ title: 'My Note', content: '...' }),
  type: 'note'
})

// Decrypt an item
const { data, verified } = await window.api.crypto.decryptItem({
  encryptedData: encrypted.encryptedData,
  nonce: encrypted.nonce,
  encryptedKey: encrypted.encryptedKey,
  keyNonce: encrypted.keyNonce,
  signature: encrypted.signature
})
```

---

## Next Steps

To continue implementation, start with Phase 3 (User Story 1: First Device Setup):

1. **T042-T053**: Implement server auth endpoints in `sync-server/src/routes/auth.ts`
2. **T054-T062**: Implement client IPC handlers for auth flow
3. **T063-T073**: Build UI components for signup/login/recovery

See `/specs/001-sync-e2ee/tasks.md` for the complete task list.
