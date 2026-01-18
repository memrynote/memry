# Crypto Module Unit Test Plan

> Last updated: January 2026
> Status: Planning

This document outlines comprehensive unit tests for the `src/main/crypto/` module.

---

## Overview

**Test Location**: `src/main/crypto/*.test.ts` (colocated with source files)
**Environment**: Node.js (main process tests use `pool: 'forks'` for isolation)
**Run Command**: `pnpm test:main` or `pnpm vitest run --project main`

---

## Test Files Structure

```
src/main/crypto/
├── cbor.ts           → cbor.test.ts
├── encryption.ts     → encryption.test.ts
├── keys.ts           → keys.test.ts
├── keychain.ts       → keychain.test.ts
├── recovery.ts       → recovery.test.ts
├── signatures.ts     → signatures.test.ts
└── index.ts          → (no tests, just exports)
```

---

## 1. `cbor.test.ts` - Canonical CBOR Encoding

### Test Cases

```typescript
describe('cbor', () => {
  describe('canonicalEncode', () => {
    it('should encode simple objects to CBOR bytes')
    it('should produce identical bytes for same data regardless of key order')
    it('should sort keys by length first (shorter first)')
    it('should sort keys alphabetically when same length')
    it('should handle nested objects')
    it('should handle arrays')
    it('should handle numbers (integers and floats)')
    it('should handle empty objects')
    it('should handle Uint8Array values')
  })

  describe('canonicalDecode', () => {
    it('should decode CBOR bytes back to original data')
    it('should be inverse of canonicalEncode')
  })

  describe('createSignaturePayload', () => {
    it('should create deterministic payload with required fields')
    it('should include optional metadata when provided')
    it('should include optional operation when provided')
    it('should produce identical bytes for identical inputs')
    it('should handle clock and fieldClocks in metadata')
  })

  describe('createLinkingHmacPayload', () => {
    it('should create deterministic payload for linking')
    it('should handle optional fields')
    it('should always include sessionId')
    it('should produce identical bytes for identical inputs')
  })

  describe('canonicalMapSorter (RFC 8949 compliance)', () => {
    it('should sort "id" before "type" (2 < 4 bytes)')
    it('should sort "data" before "nonce" (same length, d < n)')
    it('should handle numeric keys')
  })
})
```

### Key Assertions

- Cross-platform determinism (same input = same output)
- RFC 8949 Section 4.2 compliance
- Round-trip encoding/decoding

---

## 2. `encryption.test.ts` - XChaCha20-Poly1305 Encryption

### Test Cases

```typescript
describe('encryption', () => {
  describe('encrypt/decrypt', () => {
    it('should encrypt and decrypt small data')
    it('should encrypt and decrypt large data (1MB)')
    it('should produce different ciphertext for same plaintext (random nonce)')
    it('should fail decryption with wrong key')
    it('should fail decryption with wrong nonce')
    it('should fail decryption with tampered ciphertext')
    it('should reject key of wrong length')
    it('should reject nonce of wrong length')
    it('should handle empty plaintext')
    it('should handle binary data with null bytes')
  })

  describe('wrapFileKey/unwrapFileKey', () => {
    it('should wrap and unwrap file key correctly')
    it('should fail unwrap with wrong vault key')
    it('should produce 32-byte wrapped key + auth tag')
  })

  describe('encryptItem/decryptItem', () => {
    it('should encrypt string data')
    it('should encrypt Buffer data')
    it(
      'should return all required fields (encryptedData, dataNonce, encryptedKey, keyNonce, cryptoVersion)'
    )
    it('should decrypt back to original data')
    it('should use different file key for each encryption')
    it('should fail decryption with wrong vault key')
    it('should include cryptoVersion = 1')
  })

  describe('encryptItemToBase64/decryptItemFromBase64', () => {
    it('should produce valid Base64 strings')
    it('should round-trip correctly')
  })

  describe('encryptChunk/decryptChunk', () => {
    it('should encrypt individual chunks')
    it('should decrypt chunks correctly')
    it('should use unique nonce per chunk')
    it('should handle 8MB chunks')
  })

  describe('generateFileKey', () => {
    it('should generate 32-byte random key')
    it('should generate unique keys each call')
  })

  describe('generateNonce', () => {
    it('should generate 24-byte nonce for XChaCha20')
    it('should generate unique nonces')
  })

  describe('memory safety', () => {
    it('should zero out file key after encryptItem')
    it('should zero out file key after decryptItem')
  })
})
```

### Key Assertions

- Authenticated encryption (AEAD) - tamper detection
- Nonce uniqueness
- Memory safety (key zeroing)
- Correct key/nonce lengths

---

## 3. `keys.test.ts` - Key Derivation

### Test Cases

```typescript
describe('keys', () => {
  describe('deriveKey (HKDF)', () => {
    it('should derive 32-byte key from master key and context')
    it('should produce different keys for different contexts')
    it('should produce same key for same master key + context')
    it('should reject master key of wrong length')
    it('should handle long context strings')
  })

  describe('deriveVaultKey', () => {
    it('should derive vault key using correct context')
    it('should be deterministic')
  })

  describe('deriveSigningKeySeed', () => {
    it('should derive signing seed using correct context')
    it('should be deterministic')
  })

  describe('deriveVerifyKey', () => {
    it('should derive verify key using correct context')
    it('should be deterministic')
  })

  describe('generateSigningKeyPair', () => {
    it('should generate Ed25519 key pair from seed')
    it('should produce 32-byte public key')
    it('should produce 64-byte secret key')
    it('should be deterministic (same seed = same keys)')
    it('should reject seed of wrong length')
  })

  describe('deriveMasterKey (Argon2id)', () => {
    it('should derive 32-byte master key from seed and salt')
    it('should be deterministic (same inputs = same output)')
    it('should produce different keys for different salts')
    it('should reject seed < 32 bytes')
    it('should reject salt < 16 bytes')
    it('should use OWASP 2024 parameters (64MB, 3 iterations)')
  })

  describe('generateKdfSalt', () => {
    it('should generate 16-byte random salt')
    it('should generate unique salts')
  })

  describe('computeKeyVerifier', () => {
    it('should compute 32-byte HMAC verifier')
    it('should be deterministic')
    it('should use correct message "memry-key-verify-v1"')
  })

  describe('verifyKeyVerifier', () => {
    it('should return true for matching verifier')
    it('should return false for non-matching verifier')
    it('should return false for wrong master key')
  })

  describe('deriveAllKeys', () => {
    it('should derive all keys from master key')
    it('should return vaultKey, signingKeyPair, keyVerifier')
    it('should be deterministic')
    it('should return Uint8Array types')
  })
})
```

### Key Assertions

- Deterministic derivation
- Correct key sizes
- Argon2id parameters match OWASP 2024
- Context string isolation

---

## 4. `recovery.test.ts` - BIP39 Recovery Phrases

### Test Cases

```typescript
describe('recovery', () => {
  describe('generateRecoveryPhrase', () => {
    it('should generate 24-word phrase by default')
    it('should generate unique phrases each call')
    it('should only use BIP39 wordlist words')
  })

  describe('generateRecoveryPhraseWithWordCount', () => {
    it('should generate 12-word phrase')
    it('should generate 15-word phrase')
    it('should generate 18-word phrase')
    it('should generate 21-word phrase')
    it('should generate 24-word phrase')
  })

  describe('validateRecoveryPhrase', () => {
    it('should validate correct 24-word phrase')
    it('should reject empty phrase')
    it('should reject wrong word count (e.g., 23 words)')
    it('should reject invalid words not in BIP39 wordlist')
    it('should reject phrase with invalid checksum')
    it('should return wordCount in result')
    it('should return checksumValid in result')
    it('should normalize whitespace')
    it('should be case-insensitive')
  })

  describe('normalizePhrase', () => {
    it('should convert to lowercase')
    it('should trim whitespace')
    it('should collapse multiple spaces to single space')
    it('should handle tabs and newlines')
  })

  describe('mnemonicToSeed/mnemonicToSeedSync', () => {
    it('should derive 64-byte seed from phrase')
    it('should be deterministic')
    it('should support optional passphrase')
    it('should produce different seed with passphrase')
    it('should throw for invalid phrase')
  })

  describe('getConfirmationIndices', () => {
    it('should return specified number of random indices')
    it('should return sorted indices')
    it('should not return duplicate indices')
    it('should stay within word count bounds')
    it('should throw if count > wordCount')
  })

  describe('verifyConfirmationWords', () => {
    it('should return true for correct words at indices')
    it('should return false for wrong words')
    it('should return false for wrong indices')
    it('should handle case-insensitive comparison')
    it('should handle whitespace in input')
  })

  describe('getWordAtIndex', () => {
    it('should return correct word at index')
    it('should handle first word (index 0)')
    it('should handle last word (index 23)')
    it('should return undefined for out of bounds')
  })

  describe('getWordlist', () => {
    it('should return 2048 words')
    it('should include common words like "abandon"')
  })

  describe('isValidWord', () => {
    it('should return true for valid BIP39 words')
    it('should return false for invalid words')
    it('should be case-insensitive')
  })

  describe('getWordSuggestions', () => {
    it('should return words starting with prefix')
    it('should limit results')
    it('should return empty for non-matching prefix')
    it('should handle empty prefix')
  })
})
```

### Key Assertions

- BIP39 compliance
- Checksum validation
- Deterministic seed derivation
- Word count entropy mapping (12→128bits, 24→256bits)

---

## 5. `signatures.test.ts` - Ed25519 Signatures & HMAC

### Test Cases

```typescript
describe('signatures', () => {
  describe('sign/verify', () => {
    it('should sign data and verify signature')
    it('should fail verification with wrong public key')
    it('should fail verification with tampered data')
    it('should fail verification with tampered signature')
    it('should produce 64-byte signature')
    it('should reject secret key of wrong length')
    it('should sign object data via canonical CBOR')
  })

  describe('signRaw/verifyRaw', () => {
    it('should sign pre-encoded bytes')
    it('should verify pre-encoded bytes')
    it('should be consistent with sign/verify for same data')
  })

  describe('signItem/verifyItem', () => {
    it('should sign encrypted item payload')
    it('should verify encrypted item payload')
    it('should include all required fields in signature')
    it('should include optional metadata in signature')
    it('should fail verification if any field changed')
  })

  describe('signToBase64/verifyFromBase64', () => {
    it('should produce valid Base64 signature')
    it('should verify Base64 signature')
    it('should round-trip correctly')
  })

  describe('computeHmac/verifyHmac', () => {
    it('should compute 32-byte HMAC')
    it('should verify correct HMAC')
    it('should fail verification with wrong key')
    it('should fail verification with wrong data')
    it('should reject key of wrong length')
    it('should use canonical CBOR encoding')
  })

  describe('computeHmacRaw/verifyHmacRaw', () => {
    it('should compute HMAC over raw bytes')
    it('should verify HMAC over raw bytes')
  })

  describe('deterministic signatures', () => {
    it('should produce same signature for same data + key (Ed25519 is deterministic)')
  })
})
```

### Key Assertions

- Ed25519 determinism
- Signature length (64 bytes)
- HMAC length (32 bytes)
- Tamper detection

---

## 6. `keychain.test.ts` - OS Keychain Storage

### Test Cases (Mocked)

Since keychain tests require OS-level mocking, we'll mock `keytar`:

```typescript
// Mock keytar at top of test file
vi.mock('keytar', () => ({
  setPassword: vi.fn(),
  getPassword: vi.fn(),
  deletePassword: vi.fn(),
  findCredentials: vi.fn()
}))

describe('keychain', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('saveToKeychain/getFromKeychain/deleteFromKeychain', () => {
    it('should save value to keychain')
    it('should retrieve value from keychain')
    it('should delete value from keychain')
    it('should return null for non-existent key')
    it('should use correct service name "memry"')
  })

  describe('saveMasterKey/getMasterKey/deleteMasterKey/hasMasterKey', () => {
    it('should save master key as Base64')
    it('should retrieve master key as Buffer')
    it('should delete master key')
    it('should return true if master key exists')
    it('should return false if master key does not exist')
    it('should return null if no master key')
  })

  describe('saveDeviceId/getDeviceId', () => {
    it('should save and retrieve device ID')
  })

  describe('saveUserId/getUserId', () => {
    it('should save and retrieve user ID')
  })

  describe('saveTokens/getTokens/deleteTokens', () => {
    it('should save access and refresh tokens')
    it('should retrieve tokens object')
    it('should delete tokens')
    it('should return null if tokens not found')
  })

  describe('clearAllKeychainEntries', () => {
    it('should delete all known keys')
  })

  describe('getStoredKeyNames', () => {
    it('should return list of stored keys')
  })

  describe('saveSyncSession/getSyncSession/hasSyncSession/clearSyncSession', () => {
    it('should save complete sync session')
    it('should retrieve complete sync session')
    it('should return true if session exists')
    it('should return false if session incomplete')
    it('should clear all session data')
  })
})
```

### Key Assertions

- Correct keytar API usage
- Base64 encoding for binary data
- Service name consistency
- Session lifecycle

---

## Test Fixtures

Create `src/main/crypto/__fixtures__/` with reusable test data:

```typescript
// __fixtures__/index.ts
export const TEST_RECOVERY_PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

export const TEST_MASTER_KEY = Buffer.alloc(32, 0x42)
export const TEST_VAULT_KEY = Buffer.alloc(32, 0x43)
export const TEST_FILE_KEY = Buffer.alloc(32, 0x44)
export const TEST_NONCE = Buffer.alloc(24, 0x01)
export const TEST_SALT = Buffer.alloc(16, 0x02)

export const TEST_SIGNING_SEED = Buffer.alloc(32, 0x45)
export const TEST_PLAINTEXT = Buffer.from('Hello, World!', 'utf-8')
export const TEST_LARGE_PLAINTEXT = Buffer.alloc(1024 * 1024, 0x55) // 1MB

export const TEST_SIGNATURE_PAYLOAD = {
  id: 'test-id',
  type: 'note',
  cryptoVersion: 1,
  encryptedKey: 'base64key',
  keyNonce: 'base64nonce1',
  encryptedData: 'base64data',
  dataNonce: 'base64nonce2'
}
```

---

## Test Helpers

Create `src/main/crypto/__helpers__/` with utility functions:

```typescript
// __helpers__/index.ts
import { generateFileKey, generateNonce, generateKdfSalt } from '../keys'

export function createTestKeys() {
  const masterKey = Buffer.alloc(32)
  // Fill with deterministic but realistic values
  for (let i = 0; i < 32; i++) masterKey[i] = i
  return { masterKey }
}

export function createRandomKeys() {
  return {
    fileKey: generateFileKey(),
    nonce: generateNonce(24),
    salt: generateKdfSalt()
  }
}

export function expectBufferEqual(a: Buffer | Uint8Array, b: Buffer | Uint8Array) {
  expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
}

export function expectBufferNotEqual(a: Buffer | Uint8Array, b: Buffer | Uint8Array) {
  expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false)
}
```

---

## Running Tests

```bash
# Run all crypto tests
pnpm vitest run src/main/crypto

# Run with coverage
pnpm vitest run src/main/crypto --coverage

# Watch mode
pnpm vitest watch src/main/crypto

# Run specific file
pnpm vitest run src/main/crypto/encryption.test.ts
```

---

## Coverage Targets

| Metric     | Target |
| ---------- | ------ |
| Statements | 90%+   |
| Branches   | 85%+   |
| Functions  | 95%+   |
| Lines      | 90%+   |

---

## Critical Path Tests

These tests MUST pass before any sync implementation:

1. **Encryption round-trip** - `encryptItem` → `decryptItem` returns original
2. **Signature verification** - `signItem` → `verifyItem` returns true
3. **Key derivation determinism** - Same inputs always produce same keys
4. **Recovery phrase validation** - Invalid phrases are rejected
5. **Cross-platform CBOR** - Same payload produces identical bytes

---

## Implementation Order

1. **cbor.test.ts** - Foundation for signatures
2. **keys.test.ts** - Foundation for all crypto
3. **recovery.test.ts** - User-facing recovery
4. **encryption.test.ts** - Core E2EE
5. **signatures.test.ts** - Data integrity
6. **keychain.test.ts** - Storage (mocked)

---

## Summary

| File                 | Test Cases | Priority    |
| -------------------- | ---------- | ----------- |
| `cbor.test.ts`       | ~15        | P1          |
| `keys.test.ts`       | ~25        | P1          |
| `recovery.test.ts`   | ~25        | P1          |
| `encryption.test.ts` | ~30        | P1          |
| `signatures.test.ts` | ~20        | P1          |
| `keychain.test.ts`   | ~20        | P2 (mocked) |

**Total: ~135 test cases**
