/**
 * Crypto Contracts
 *
 * Defines all types and interfaces for the end-to-end encryption system.
 */

import { z } from 'zod'
import type { VectorClock } from './sync-api'

// =============================================================================
// Constants
// =============================================================================

/**
 * Current crypto algorithm version.
 *
 * Version 1 algorithms:
 * - Encryption: XChaCha20-Poly1305 (24-byte nonce)
 * - Key Derivation: Argon2id (64MB, 3 iterations)
 * - Signatures: Ed25519
 * - Key Exchange: X25519
 * - Hash: SHA-256
 */
export const CRYPTO_VERSION = 1 as const
export type CryptoVersion = typeof CRYPTO_VERSION

/**
 * HKDF context strings for key derivation
 */
export const HKDF_CONTEXTS = {
  /** Key for encrypting/decrypting file keys */
  VAULT_KEY: 'memry-vault-key-v1',

  /** Seed for Ed25519 signing keypair (user-level) */
  SIGNING_KEY: 'memry-signing-key-v1',

  /** Key verifier (stored server-side for recovery phrase checks) */
  VERIFY_KEY: 'memry-verify-key-v1',

  /** Encryption key for device linking */
  LINKING_ENC: 'memry-linking-enc-v1',

  /** MAC key for device linking */
  LINKING_MAC: 'memry-linking-mac-v1',

  /** Key verifier input */
  KEY_VERIFY_INPUT: 'memry-key-verify-v1'
} as const

/**
 * Argon2id parameters for master key derivation.
 *
 * Note: libsodium's crypto_pwhash does not expose parallelism parameter.
 * The underlying Argon2id implementation uses parallelism=1 internally.
 * This is acceptable for our use case since:
 * 1. We're running in the main process (single-threaded context)
 * 2. The memory cost (64MB) and time cost (3 iterations) provide sufficient protection
 * 3. OWASP recommends these parameters for password hashing in 2024
 */
export const ARGON2_PARAMS = {
  /** Memory cost in KiB (64MB) */
  memoryCost: 65536,

  /** Time cost (iterations) */
  timeCost: 3,

  /**
   * Parallelism - libsodium uses 1 internally (not configurable).
   * Stored for documentation purposes and potential future migration.
   */
  parallelism: 1,

  /** Output key length in bytes */
  keyLength: 32
} as const

/**
 * XChaCha20-Poly1305 parameters
 */
export const XCHACHA_PARAMS = {
  /** Nonce size in bytes */
  nonceSize: 24,

  /** Key size in bytes */
  keySize: 32,

  /** Authentication tag size in bytes */
  tagSize: 16
} as const

/**
 * Ed25519 parameters
 */
export const ED25519_PARAMS = {
  /** Public key size in bytes */
  publicKeySize: 32,

  /** Private key size in bytes */
  privateKeySize: 64,

  /** Seed size in bytes */
  seedSize: 32,

  /** Signature size in bytes */
  signatureSize: 64
} as const

/**
 * X25519 parameters
 */
export const X25519_PARAMS = {
  /** Public key size in bytes */
  publicKeySize: 32,

  /** Private key size in bytes */
  privateKeySize: 32,

  /** Shared secret size in bytes */
  sharedSecretSize: 32
} as const

// =============================================================================
// Zod Schemas
// =============================================================================

const Base64Schema = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/, 'Invalid Base64 string')
const UuidSchema = z.uuid()

// =============================================================================
// Encrypted Item Types
// =============================================================================

/**
 * Encrypted item stored in R2
 */
export interface EncryptedItem {
  /** Item UUID */
  id: string

  /** Item type */
  type: 'note' | 'task' | 'project' | 'settings' | 'inbox' | 'filter' | 'journal'

  /** Algorithm version (currently 1) */
  cryptoVersion: CryptoVersion

  /** File key encrypted with Vault Key (Base64) */
  encryptedKey: string

  /** Nonce for key encryption (Base64) */
  keyNonce: string

  /** Content encrypted with File Key (Base64) */
  encryptedData: string

  /** Nonce for data encryption (Base64) */
  dataNonce: string

  /** Ed25519 signature (Base64) */
  signature: string

  /** Device ID that signed this item */
  signerDeviceId: string

  /** Optional timestamp for diagnostics */
  signedAt?: number

  /** Sync metadata for non-CRDT items */
  clock?: VectorClock

  /** Per-field clocks for LWW merge */
  fieldClocks?: Record<string, VectorClock>
}

export const EncryptedItemSchema = z.object({
  id: UuidSchema,
  type: z.enum(['note', 'task', 'project', 'settings', 'inbox', 'filter', 'journal']),
  cryptoVersion: z.literal(CRYPTO_VERSION),
  encryptedKey: Base64Schema,
  keyNonce: Base64Schema,
  encryptedData: Base64Schema,
  dataNonce: Base64Schema,
  signature: Base64Schema,
  signerDeviceId: UuidSchema,
  signedAt: z.number().int().positive().optional(),
  clock: z.record(z.string(), z.number().int().nonnegative()).optional(),
  fieldClocks: z.record(z.string(), z.record(z.string(), z.number().int().nonnegative())).optional()
})

/**
 * Encrypted CRDT item (for notes using Yjs)
 */
export interface EncryptedCrdtItem {
  /** Note UUID */
  id: string

  /** Always 'note' for CRDT items */
  type: 'note'

  /** Algorithm version */
  cryptoVersion: CryptoVersion

  /** Full Yjs state snapshot (Base64, encrypted) */
  encryptedSnapshot: string

  /** Nonce for snapshot encryption (Base64) */
  snapshotNonce: string

  /** Yjs state vector (unencrypted for sync protocol) */
  stateVector: string

  /** File key encrypted with Vault Key (Base64) */
  encryptedKey: string

  /** Nonce for key encryption (Base64) */
  keyNonce: string

  /** Ed25519 signature (Base64) */
  signature: string

  /** Device ID that signed this item */
  signerDeviceId: string

  /** Incremental updates since last snapshot */
  updates: EncryptedUpdate[]
}

export const EncryptedCrdtItemSchema = z.object({
  id: UuidSchema,
  type: z.literal('note'),
  cryptoVersion: z.literal(CRYPTO_VERSION),
  encryptedSnapshot: Base64Schema,
  snapshotNonce: Base64Schema,
  stateVector: z.string(),
  encryptedKey: Base64Schema,
  keyNonce: Base64Schema,
  signature: Base64Schema,
  signerDeviceId: UuidSchema,
  updates: z.array(
    z.object({
      encryptedData: Base64Schema,
      nonce: Base64Schema,
      timestamp: z.number().int().positive(),
      signature: Base64Schema
    })
  )
})

/**
 * Encrypted Yjs update
 */
export interface EncryptedUpdate {
  /** Encrypted Yjs update (Base64) */
  encryptedData: string

  /** Nonce for update encryption (Base64) */
  nonce: string

  /** Timestamp of update */
  timestamp: number

  /** Signature covering note id + encryptedData + nonce + timestamp */
  signature: string
}

// =============================================================================
// Signature Payload Types
// =============================================================================

/**
 * Payload structure for Ed25519 signatures.
 * Use canonical CBOR (RFC 8949) for deterministic encoding.
 */
export interface SignaturePayloadV1 {
  /** Item UUID */
  id: string

  /** Item type */
  type: string

  /** Operation type (if applicable) */
  operation?: 'create' | 'update' | 'delete'

  /** Algorithm version */
  cryptoVersion: CryptoVersion

  /** Wrapped file key (Base64) */
  encryptedKey: string

  /** Nonce for key wrapping (Base64) */
  keyNonce: string

  /** The encrypted content (Base64) */
  encryptedData: string

  /** Encryption nonce (Base64) */
  dataNonce: string

  /** Optional metadata */
  metadata?: {
    clock?: VectorClock
    fieldClocks?: Record<string, VectorClock>
    stateVector?: string
  }
}

export const SignaturePayloadV1Schema = z.object({
  id: UuidSchema,
  type: z.string(),
  operation: z.enum(['create', 'update', 'delete']).optional(),
  cryptoVersion: z.literal(CRYPTO_VERSION),
  encryptedKey: Base64Schema,
  keyNonce: Base64Schema,
  encryptedData: Base64Schema,
  dataNonce: Base64Schema,
  metadata: z
    .object({
      clock: z.record(z.string(), z.number().int().nonnegative()).optional(),
      fieldClocks: z
        .record(z.string(), z.record(z.string(), z.number().int().nonnegative()))
        .optional(),
      stateVector: z.string().optional()
    })
    .optional()
})

// =============================================================================
// Attachment Types
// =============================================================================

/**
 * Attachment manifest (encrypted)
 */
export interface AttachmentManifest {
  /** Attachment UUID */
  id: string

  /** Original filename */
  filename: string

  /** MIME type */
  mimeType: string

  /** Total bytes */
  size: number

  /** SHA-256 of original file */
  checksum: string

  /** Chunk references */
  chunks: ChunkRef[]

  /** Chunk size (8MB default) */
  chunkSize: number

  /** Creation timestamp */
  createdAt: number
}

/**
 * Reference to a chunk in R2
 */
export interface ChunkRef {
  /** Position in file (0-based) */
  index: number

  /** SHA-256 of plaintext chunk */
  hash: string

  /** SHA-256 of encrypted chunk (for R2 lookup) */
  encryptedHash: string

  /** Actual chunk size */
  size: number
}

/**
 * Encrypted attachment manifest
 */
export interface EncryptedAttachmentManifest {
  /** Base64 encrypted AttachmentManifest */
  encryptedManifest: string

  /** Nonce (Base64) */
  manifestNonce: string

  /** File key encrypted with Vault Key (Base64) */
  encryptedFileKey: string

  /** Nonce for key encryption (Base64) */
  keyNonce: string

  /** Ed25519 signature */
  manifestSignature: string
}

/**
 * Attachment reference stored in notes/tasks
 */
export interface AttachmentRef {
  /** Attachment ID */
  id: string

  /** Points to encrypted manifest */
  manifestId: string

  /** Filename for display */
  filename: string

  /** Size for progress display */
  size: number

  /** MIME type */
  mimeType: string

  /** Base64 thumbnail for images/videos/PDFs */
  thumbnail?: string

  /** Creation timestamp */
  createdAt: number
}

// =============================================================================
// Key Types
// =============================================================================

/**
 * Key material stored in OS keychain via keytar
 */
export interface StoredKeyMaterial {
  /** Master key (32 bytes, Base64) */
  masterKey: string

  /** KDF salt used to derive master key (Base64) */
  kdfSalt: string

  /** Device signing private key (64 bytes, Base64) */
  deviceSigningKey: string

  /** Device signing public key (32 bytes, Base64) */
  devicePublicKey: string

  /** Device ID */
  deviceId: string

  /** User ID */
  userId: string
}

/**
 * Derived keys from master key
 */
export interface DerivedKeys {
  /** Vault key for encrypting/decrypting file keys */
  vaultKey: Uint8Array

  /** Ed25519 signing keypair (user-level) */
  signingKeyPair: {
    publicKey: Uint8Array
    privateKey: Uint8Array
  }

  /** Key verifier for master key verification */
  verifyKey: Uint8Array
}

/**
 * Device signing keypair (generated locally, not derived)
 */
export interface DeviceSigningKeyPair {
  /** Ed25519 public key */
  publicKey: Uint8Array

  /** Ed25519 private key */
  privateKey: Uint8Array

  /** Device ID */
  deviceId: string
}

// =============================================================================
// Recovery Types
// =============================================================================

/**
 * Recovery phrase state
 */
export interface RecoveryPhraseState {
  /** BIP39 mnemonic (24 words) */
  phrase: string[]

  /** Whether phrase has been backed up by user */
  backedUp: boolean

  /** When phrase was generated */
  generatedAt: number
}

/**
 * Master key derivation input
 */
export interface MasterKeyDerivationInput {
  /** BIP39 mnemonic (24 words) */
  phrase: string[]

  /** KDF salt from server (Base64) */
  kdfSalt: string
}

// =============================================================================
// Linking Types
// =============================================================================

/**
 * Ephemeral X25519 keypair for device linking
 */
export interface LinkingKeyPair {
  /** X25519 public key (Base64) */
  publicKey: string

  /** X25519 private key (Base64) - only stored in memory */
  privateKey: string
}

/**
 * Derived keys for device linking handshake
 */
export interface LinkingDerivedKeys {
  /** Encryption key for master key transfer */
  encryptionKey: Uint8Array

  /** MAC key for proof of possession */
  macKey: Uint8Array
}

// =============================================================================
// Helper Types
// =============================================================================

/**
 * Result of encryption operation
 */
export interface EncryptionResult {
  /** Encrypted data (Uint8Array) */
  ciphertext: Uint8Array

  /** Nonce used (Uint8Array) */
  nonce: Uint8Array
}

/**
 * Result of decryption operation
 */
export interface DecryptionResult {
  /** Decrypted data (Uint8Array) */
  plaintext: Uint8Array
}

/**
 * Result of signature operation
 */
export interface SignatureResult {
  /** Ed25519 signature (Uint8Array) */
  signature: Uint8Array

  /** Device ID that signed */
  signerDeviceId: string
}

/**
 * Result of signature verification
 */
export interface VerificationResult {
  /** Whether signature is valid */
  valid: boolean

  /** Error message if invalid */
  error?: string
}

// =============================================================================
// Vector Clock Operations
// =============================================================================

/**
 * Increment clock for local change
 */
export function incrementClock(clock: VectorClock, deviceId: string): VectorClock {
  return {
    ...clock,
    [deviceId]: (clock[deviceId] ?? 0) + 1
  }
}

/**
 * Merge two clocks (take max of each device)
 */
export function mergeClock(a: VectorClock, b: VectorClock): VectorClock {
  const merged: VectorClock = { ...a }
  for (const [device, time] of Object.entries(b)) {
    merged[device] = Math.max(merged[device] ?? 0, time)
  }
  return merged
}

/**
 * Compare clocks: -1 (a < b), 0 (concurrent), 1 (a > b)
 */
export function compareClock(a: VectorClock, b: VectorClock): -1 | 0 | 1 {
  const devices = new Set([...Object.keys(a), ...Object.keys(b)])

  let aGreater = false
  let bGreater = false

  for (const device of devices) {
    const aVal = a[device] ?? 0
    const bVal = b[device] ?? 0
    if (aVal > bVal) aGreater = true
    if (bVal > aVal) bGreater = true
  }

  if (aGreater && !bGreater) return 1
  if (bGreater && !aGreater) return -1
  return 0 // Concurrent
}

/**
 * Check if clock a dominates clock b (a >= b for all devices)
 */
export function clockDominates(a: VectorClock, b: VectorClock): boolean {
  for (const [device, bVal] of Object.entries(b)) {
    const aVal = a[device] ?? 0
    if (aVal < bVal) return false
  }
  return true
}

/**
 * Create a new empty clock
 */
export function emptyClock(): VectorClock {
  return {}
}
