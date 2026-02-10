import { z } from 'zod'
import {
  ENCRYPTABLE_ITEM_TYPES,
  SYNC_OPERATIONS,
  type EncryptableItemType,
  type SyncOperation
} from './sync-api'

// ============================================================================
// Version
// ============================================================================

export type CryptoVersion = 1
export const CRYPTO_VERSION: CryptoVersion = 1

// ============================================================================
// Algorithm Constants
// ============================================================================

export const KEY_DERIVATION_CONTEXTS = {
  VAULT_KEY: 'memry-vault-key-v1',
  SIGNING_KEY: 'memry-signing-key-v1',
  VERIFY_KEY: 'memry-verify-key-v1',
  KEY_VERIFIER: 'memry-key-verifier-v1'
} as const

// libsodium's crypto_pwhash uses Argon2id with parallelism=1 internally.
// The spec references parallelism=4 but libsodium does not expose this parameter;
// parallelism=1 is the canonical value for this implementation.
export const ARGON2_PARAMS = {
  MEMORY_LIMIT: 67108864,
  OPS_LIMIT: 3,
  SALT_LENGTH: 16
} as const

export const XCHACHA20_PARAMS = {
  NONCE_LENGTH: 24,
  KEY_LENGTH: 32,
  TAG_LENGTH: 16
} as const

export const ED25519_PARAMS = {
  SEED_LENGTH: 32,
  PUBLIC_KEY_LENGTH: 32,
  SECRET_KEY_LENGTH: 64,
  SIGNATURE_LENGTH: 64
} as const

export const X25519_PARAMS = {
  PUBLIC_KEY_LENGTH: 32,
  SECRET_KEY_LENGTH: 32,
  SHARED_SECRET_LENGTH: 32
} as const

// "HKDF" in the spec refers to BLAKE2b-based KDF as implemented by
// libsodium's crypto_kdf_derive_from_key, not traditional HKDF-SHA256.
export const LINKING_HKDF_CONTEXTS = {
  ENCRYPTION: 'memry-linking-enc-v1',
  MAC: 'memry-linking-mac-v1'
} as const

// ============================================================================
// Keychain
// ============================================================================

export interface KeychainEntry {
  service: string
  account: string
}

export const KEYCHAIN_ENTRIES = {
  MASTER_KEY: { service: 'com.memry.sync', account: 'master-key' },
  VAULT_KEY: { service: 'com.memry.sync', account: 'vault-key' },
  DEVICE_SIGNING_KEY: { service: 'com.memry.sync', account: 'device-signing-key' },
  ACCESS_TOKEN: { service: 'com.memry.sync', account: 'access-token' },
  REFRESH_TOKEN: { service: 'com.memry.sync', account: 'refresh-token' },
  SETUP_TOKEN: { service: 'com.memry.sync', account: 'setup-token' }
} as const satisfies Record<string, KeychainEntry>

// ============================================================================
// Key Material Types (internal, contain Uint8Array)
// ============================================================================

export interface MasterKeyMaterial {
  masterKey: Uint8Array
  kdfSalt: string
  keyVerifier: string
}

export interface VaultKeyMaterial {
  vaultKey: Uint8Array
}

export interface SigningKeyPair {
  publicKey: Uint8Array
  secretKey: Uint8Array
}

export interface DeviceSigningKeyPair {
  deviceId: string
  publicKey: Uint8Array
  secretKey: Uint8Array
}

export interface EphemeralKeyPair {
  publicKey: Uint8Array
  secretKey: Uint8Array
}

export interface RecoveryPhraseResult {
  phrase: string
  seed: Uint8Array
}

export interface KeyDerivationParams {
  seed: Uint8Array
  salt: Uint8Array
  opsLimit: number
  memLimit: number
}

// ============================================================================
// Encrypted Item Types (serialized, Base64 strings)
// ============================================================================

export interface EncryptedItem {
  id: string
  type: EncryptableItemType
  cryptoVersion: CryptoVersion
  encryptedKey: string
  keyNonce: string
  encryptedData: string
  dataNonce: string
  signature: string
  signerDeviceId: string
  signedAt?: number
  clock?: Record<string, number>
  fieldClocks?: Record<string, Record<string, number>>
}

export interface EncryptedCrdtItem {
  id: string
  type: 'note'
  cryptoVersion: CryptoVersion
  encryptedSnapshot: string
  snapshotNonce: string
  stateVector: string
  encryptedKey: string
  keyNonce: string
  signature: string
  signerDeviceId: string
}

export interface SignaturePayloadV1 {
  id: string
  type: string
  operation?: SyncOperation
  cryptoVersion: CryptoVersion
  encryptedKey: string
  keyNonce: string
  encryptedData: string
  dataNonce: string
  deletedAt?: number
  metadata?: {
    clock?: Record<string, number>
    fieldClocks?: Record<string, Record<string, number>>
    stateVector?: string
  }
}

// ============================================================================
// Zod Schemas (for runtime validation at IPC/network boundaries)
// ============================================================================

const CryptoVectorClockSchema = z.record(z.string(), z.number().int().nonnegative())

const FieldClocksSchema = z.record(z.string(), z.record(z.string(), z.number().int().nonnegative()))

export const EncryptedItemSchema = z.object({
  id: z.string().min(1),
  type: z.enum(ENCRYPTABLE_ITEM_TYPES),
  cryptoVersion: z.literal(CRYPTO_VERSION),
  encryptedKey: z.string().min(1),
  keyNonce: z.string().min(1),
  encryptedData: z.string().min(1),
  dataNonce: z.string().min(1),
  signature: z.string().min(1),
  signerDeviceId: z.string().min(1),
  signedAt: z.number().optional(),
  clock: CryptoVectorClockSchema.optional(),
  fieldClocks: FieldClocksSchema.optional()
})

export const EncryptedCrdtItemSchema = z.object({
  id: z.string().min(1),
  type: z.literal('note'),
  cryptoVersion: z.literal(CRYPTO_VERSION),
  encryptedSnapshot: z.string().min(1),
  snapshotNonce: z.string().min(1),
  stateVector: z.string().min(1),
  encryptedKey: z.string().min(1),
  keyNonce: z.string().min(1),
  signature: z.string().min(1),
  signerDeviceId: z.string().min(1)
})

export const SignaturePayloadV1Schema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  operation: z.enum(SYNC_OPERATIONS).optional(),
  cryptoVersion: z.literal(CRYPTO_VERSION),
  encryptedKey: z.string().min(1),
  keyNonce: z.string().min(1),
  encryptedData: z.string().min(1),
  dataNonce: z.string().min(1),
  deletedAt: z.number().optional(),
  metadata: z
    .object({
      clock: CryptoVectorClockSchema.optional(),
      fieldClocks: FieldClocksSchema.optional(),
      stateVector: z.string().min(1).optional()
    })
    .optional()
})

// ============================================================================
// Type Inference
// ============================================================================

export type EncryptedItemInput = z.infer<typeof EncryptedItemSchema>
export type EncryptedCrdtItemInput = z.infer<typeof EncryptedCrdtItemSchema>
export type SignaturePayloadV1Input = z.infer<typeof SignaturePayloadV1Schema>
