/**
 * Cryptography Types
 *
 * Shared types for encryption, signatures, and key management.
 *
 * @module shared/contracts/crypto
 */

import { z } from 'zod'
import type { VectorClock } from './sync-api'

// =============================================================================
// Crypto Version
// =============================================================================

/**
 * Current crypto algorithm version.
 * Version 1:
 * - Encryption: XChaCha20-Poly1305 (24-byte nonce)
 * - Key Derivation: Argon2id (64MB, 3 iterations)
 * - Signatures: Ed25519
 * - Key Exchange: X25519
 * - Hash: SHA-256
 */
export const CRYPTO_VERSION = 1 as const

export type CryptoVersion = typeof CRYPTO_VERSION

// =============================================================================
// Key Derivation Types
// =============================================================================

/**
 * Argon2id parameters for key derivation
 */
export interface Argon2Params {
  memoryCost: number // Memory in KB (default: 65536 = 64MB)
  timeCost: number // Iterations (default: 3)
  parallelism: number // Parallel lanes (default: 4)
  hashLength: number // Output length in bytes (default: 32)
}

/**
 * Default Argon2id parameters (OWASP 2024 recommended)
 */
export const DEFAULT_ARGON2_PARAMS: Argon2Params = {
  memoryCost: 65536, // 64 MB
  timeCost: 3, // 3 iterations
  parallelism: 4, // 4 lanes
  hashLength: 32, // 256-bit output
}

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
} as const

export type HKDFContext = (typeof HKDF_CONTEXTS)[keyof typeof HKDF_CONTEXTS]

/**
 * Derived keys from master key
 */
export interface DerivedKeys {
  masterKey: Uint8Array // 32 bytes
  vaultKey: Uint8Array // 32 bytes - for encrypting file keys
  signingKeyPair: {
    publicKey: Uint8Array // 32 bytes
    secretKey: Uint8Array // 64 bytes
  }
  verifyKey: Uint8Array // 32 bytes - for key verifier HMAC
  keyVerifier: Uint8Array // 32 bytes - HMAC output stored on server
}

// =============================================================================
// Encryption Types
// =============================================================================

/**
 * Result of an encryption operation
 */
export interface EncryptResult {
  ciphertext: Uint8Array
  nonce: Uint8Array // 24 bytes for XChaCha20-Poly1305
}

/**
 * Encrypted item structure stored in R2
 */
export interface EncryptedItem {
  id: string
  type: 'note' | 'task' | 'project' | 'settings'
  cryptoVersion: CryptoVersion

  // Encrypted content
  encryptedKey: string // File key encrypted with Vault Key (Base64)
  keyNonce: string // Nonce for key encryption (Base64)
  encryptedData: string // Content encrypted with File Key (Base64)
  dataNonce: string // Nonce for data encryption (Base64)

  // Integrity - signature covers: id + type + cryptoVersion + encryptedKey + keyNonce +
  // encryptedData + dataNonce + clock/fieldClocks when present
  signature: string // Ed25519 signature (Base64)
  signedAt?: number // Optional timestamp for diagnostics

  // Sync metadata (for non-CRDT items)
  clock?: VectorClock
  fieldClocks?: { [field: string]: VectorClock }
}

/**
 * Zod schema for encrypted item
 */
export const EncryptedItemSchema = z.object({
  id: z.string(),
  type: z.enum(['note', 'task', 'project', 'settings']),
  cryptoVersion: z.number(),
  encryptedKey: z.string(),
  keyNonce: z.string(),
  encryptedData: z.string(),
  dataNonce: z.string(),
  signature: z.string(),
  signedAt: z.number().optional(),
  clock: z.record(z.string(), z.number()).optional(),
  fieldClocks: z.record(z.string(), z.record(z.string(), z.number())).optional(),
})

/**
 * Encrypted CRDT item (for notes)
 */
export interface EncryptedCrdtItem {
  id: string
  type: 'note'
  cryptoVersion: CryptoVersion

  // Encrypted Yjs state
  encryptedSnapshot: string // Full Yjs state (Base64)
  snapshotNonce: string // Nonce (Base64)
  stateVector: string // Yjs state vector (unencrypted for sync protocol)

  // File key
  encryptedKey: string
  keyNonce: string

  // Integrity
  signature: string // Signature includes encryptedSnapshot + snapshotNonce + stateVector + encryptedKey

  // Incremental updates
  updates: EncryptedUpdate[]
}

/**
 * Encrypted incremental update for CRDT
 */
export interface EncryptedUpdate {
  encryptedData: string // Yjs update (Base64)
  nonce: string
  timestamp: number
  signature: string // Signature includes note id + encryptedData + nonce + timestamp
}

/**
 * Zod schema for encrypted update
 */
export const EncryptedUpdateSchema = z.object({
  encryptedData: z.string(),
  nonce: z.string(),
  timestamp: z.number(),
  signature: z.string(),
})

/**
 * Zod schema for encrypted CRDT item
 */
export const EncryptedCrdtItemSchema = z.object({
  id: z.string(),
  type: z.literal('note'),
  cryptoVersion: z.number(),
  encryptedSnapshot: z.string(),
  snapshotNonce: z.string(),
  stateVector: z.string(),
  encryptedKey: z.string(),
  keyNonce: z.string(),
  signature: z.string(),
  updates: z.array(EncryptedUpdateSchema),
})

// =============================================================================
// Signature Types
// =============================================================================

/**
 * Payload structure for Ed25519 signatures (Version 1)
 * Use canonical CBOR (RFC 8949) for deterministic encoding.
 */
export interface SignaturePayloadV1 {
  id: string
  type: string
  operation?: 'create' | 'update' | 'delete'
  cryptoVersion: number
  encryptedKey: string
  keyNonce: string
  encryptedData: string
  dataNonce: string
  metadata?: {
    clock?: VectorClock
    fieldClocks?: { [field: string]: VectorClock }
    stateVector?: string
  }
}

/**
 * Zod schema for signature payload
 */
export const SignaturePayloadV1Schema = z.object({
  id: z.string(),
  type: z.string(),
  operation: z.enum(['create', 'update', 'delete']).optional(),
  cryptoVersion: z.number(),
  encryptedKey: z.string(),
  keyNonce: z.string(),
  encryptedData: z.string(),
  dataNonce: z.string(),
  metadata: z
    .object({
      clock: z.record(z.string(), z.number()).optional(),
      fieldClocks: z.record(z.string(), z.record(z.string(), z.number())).optional(),
      stateVector: z.string().optional(),
    })
    .optional(),
})

/**
 * Result of a signature verification
 */
export interface SignatureVerificationResult {
  valid: boolean
  error?: string
}

// =============================================================================
// Recovery Phrase Types
// =============================================================================

/**
 * BIP39 word counts
 */
export type Bip39WordCount = 12 | 15 | 18 | 21 | 24

/**
 * Recovery phrase configuration
 */
export interface RecoveryPhraseConfig {
  wordCount: Bip39WordCount
  language: 'english' // Currently only English is supported
}

/**
 * Default recovery phrase configuration (24 words = 256 bits entropy)
 */
export const DEFAULT_RECOVERY_PHRASE_CONFIG: RecoveryPhraseConfig = {
  wordCount: 24,
  language: 'english',
}

/**
 * Recovery phrase validation result
 */
export interface RecoveryPhraseValidation {
  valid: boolean
  error?: string
  wordCount?: number
  checksumValid?: boolean
}

// =============================================================================
// Keychain Types
// =============================================================================

/**
 * Keys stored in the OS keychain
 */
export const KEYCHAIN_KEYS = {
  MASTER_KEY: 'master-key',
  DEVICE_ID: 'device-id',
  USER_ID: 'user-id',
  ACCESS_TOKEN: 'access-token',
  REFRESH_TOKEN: 'refresh-token',
  PENDING_SIGNUP: 'pending-signup',
} as const

export type KeychainKey = (typeof KEYCHAIN_KEYS)[keyof typeof KEYCHAIN_KEYS]

// =============================================================================
// Attachment Types
// =============================================================================

/**
 * Chunk reference in an attachment manifest
 */
export interface ChunkRef {
  index: number // Position in file (0-based)
  hash: string // SHA-256 of plaintext chunk
  encryptedHash: string // SHA-256 of encrypted chunk (for R2 lookup)
  size: number // Actual chunk size
}

/**
 * Zod schema for chunk reference
 */
export const ChunkRefSchema = z.object({
  index: z.number(),
  hash: z.string(),
  encryptedHash: z.string(),
  size: z.number(),
})

/**
 * Attachment manifest (stored encrypted)
 */
export interface AttachmentManifest {
  id: string
  filename: string
  mimeType: string
  size: number // Total bytes
  checksum: string // SHA-256 of original file
  chunks: ChunkRef[]
  chunkSize: number // 8MB (8388608)
  createdAt: number
}

/**
 * Zod schema for attachment manifest
 */
export const AttachmentManifestSchema = z.object({
  id: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  size: z.number(),
  checksum: z.string(),
  chunks: z.array(ChunkRefSchema),
  chunkSize: z.number(),
  createdAt: z.number(),
})

/**
 * Encrypted attachment manifest
 */
export interface EncryptedAttachmentManifest {
  encryptedManifest: string // Base64 encrypted AttachmentManifest
  manifestNonce: string // Nonce (Base64)
  encryptedFileKey: string // File key encrypted with Vault Key (Base64)
  keyNonce: string // Nonce for key encryption (Base64)
  manifestSignature: string // Ed25519 signature over encryptedManifest + manifestNonce + encryptedFileKey + keyNonce
}

/**
 * Zod schema for encrypted attachment manifest
 */
export const EncryptedAttachmentManifestSchema = z.object({
  encryptedManifest: z.string(),
  manifestNonce: z.string(),
  encryptedFileKey: z.string(),
  keyNonce: z.string(),
  manifestSignature: z.string(),
})

/**
 * Attachment reference (stored in notes/tasks)
 */
export interface AttachmentRef {
  id: string
  manifestId: string
  filename: string
  size: number
  mimeType: string
  thumbnail?: string // Base64 thumbnail for images/videos/PDFs
  createdAt: number
}

/**
 * Zod schema for attachment reference
 */
export const AttachmentRefSchema = z.object({
  id: z.string(),
  manifestId: z.string(),
  filename: z.string(),
  size: z.number(),
  mimeType: z.string(),
  thumbnail: z.string().optional(),
  createdAt: z.number(),
})

// =============================================================================
// Device Linking Types
// =============================================================================

/**
 * X25519 key pair for device linking
 */
export interface X25519KeyPair {
  publicKey: Uint8Array // 32 bytes
  secretKey: Uint8Array // 32 bytes
}

/**
 * Derived keys from ECDH shared secret for device linking
 */
export interface LinkingKeys {
  encKey: Uint8Array // 32 bytes - for encrypting master key
  macKey: Uint8Array // 32 bytes - for HMAC proofs
}

/**
 * Linking request data sent by new device
 */
export interface LinkingRequest {
  sessionId: string
  token: string
  newDevicePublicKey: string // Base64
  newDeviceConfirm: string // Base64 - HMAC proof
  deviceName: string
  devicePlatform: 'macos' | 'windows' | 'linux' | 'ios' | 'android'
}

/**
 * Zod schema for linking request
 */
export const LinkingRequestSchema = z.object({
  sessionId: z.string(),
  token: z.string(),
  newDevicePublicKey: z.string(),
  newDeviceConfirm: z.string(),
  deviceName: z.string(),
  devicePlatform: z.enum(['macos', 'windows', 'linux', 'ios', 'android']),
})

/**
 * Linking approval data sent by existing device
 */
export interface LinkingApproval {
  sessionId: string
  encryptedMasterKey: string // Base64
  nonce: string // Base64
  keyConfirm: string // Base64 - HMAC confirmation
}

/**
 * Zod schema for linking approval
 */
export const LinkingApprovalSchema = z.object({
  sessionId: z.string(),
  encryptedMasterKey: z.string(),
  nonce: z.string(),
  keyConfirm: z.string(),
})

// =============================================================================
// Key Rotation Types
// =============================================================================

/**
 * Key rotation progress
 */
export interface KeyRotationProgress {
  status: 'idle' | 'in_progress' | 'completed' | 'failed'
  totalItems: number
  processedItems: number
  currentItem?: string
  error?: string
  startedAt?: number
  completedAt?: number
}

/**
 * Zod schema for key rotation progress
 */
export const KeyRotationProgressSchema = z.object({
  status: z.enum(['idle', 'in_progress', 'completed', 'failed']),
  totalItems: z.number(),
  processedItems: z.number(),
  currentItem: z.string().optional(),
  error: z.string().optional(),
  startedAt: z.number().optional(),
  completedAt: z.number().optional(),
})
