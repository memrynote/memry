/**
 * Crypto Module
 *
 * Central export point for all cryptographic operations.
 *
 * Key Modules:
 * - keys: HKDF, Argon2id, key generation
 * - recovery: BIP39 recovery phrase management
 * - encryption: XChaCha20-Poly1305 AEAD
 * - signatures: Ed25519 signing and HMAC
 * - keychain: OS keychain storage
 * - cbor: Canonical CBOR encoding
 *
 * @module main/crypto
 */

// =============================================================================
// Key Derivation
// =============================================================================

export {
  // HKDF derivation
  deriveKey,
  deriveVaultKey,
  deriveSigningKeySeed,
  deriveVerifyKey,
  // Ed25519 key generation
  generateSigningKeyPair,
  // Argon2id
  deriveMasterKey,
  generateKdfSalt,
  // Key verifier
  computeKeyVerifier,
  verifyKeyVerifier,
  // Complete derivation
  deriveAllKeys,
  // Random generation
  generateFileKey,
  generateNonce
} from './keys'

// =============================================================================
// Recovery Phrase
// =============================================================================

export {
  // Generation
  generateRecoveryPhrase,
  generateRecoveryPhraseWithWordCount,
  // Validation
  validateRecoveryPhrase,
  normalizePhrase,
  // Seed derivation
  mnemonicToSeed,
  mnemonicToSeedSync,
  // Confirmation
  getConfirmationIndices,
  verifyConfirmationWords,
  getWordAtIndex,
  // Wordlist
  getWordlist,
  isValidWord,
  getWordSuggestions
} from './recovery'

// =============================================================================
// Encryption
// =============================================================================

export {
  // Basic encryption
  encrypt,
  decrypt,
  // File key wrapping
  wrapFileKey,
  unwrapFileKey,
  // Item encryption
  encryptItem,
  decryptItem,
  encryptItemToBase64,
  decryptItemFromBase64,
  // Chunk encryption (for attachments)
  encryptChunk,
  decryptChunk
} from './encryption'

// =============================================================================
// Signatures
// =============================================================================

export {
  // Basic signing
  sign,
  verify,
  signRaw,
  verifyRaw,
  // Item signing
  signItem,
  verifyItem,
  // Base64 helpers
  signToBase64,
  verifyFromBase64,
  // HMAC
  computeHmac,
  verifyHmac,
  computeHmacRaw,
  verifyHmacRaw
} from './signatures'

// =============================================================================
// Keychain
// =============================================================================

export {
  // Basic operations
  saveToKeychain,
  getFromKeychain,
  deleteFromKeychain,
  // Master key
  saveMasterKey,
  getMasterKey,
  deleteMasterKey,
  hasMasterKey,
  // Device/User ID
  saveDeviceId,
  getDeviceId,
  saveUserId,
  getUserId,
  // Tokens
  saveTokens,
  getTokens,
  deleteTokens,
  // Bulk operations
  clearAllKeychainEntries,
  getStoredKeyNames,
  // Sync session
  saveSyncSession,
  getSyncSession,
  hasSyncSession,
  clearSyncSession
} from './keychain'

// =============================================================================
// CBOR
// =============================================================================

export {
  canonicalEncode,
  canonicalDecode,
  createSignaturePayload,
  createLinkingHmacPayload
} from './cbor'

// =============================================================================
// Re-export Types
// =============================================================================

export type {
  DerivedKeys,
  EncryptResult,
  RecoveryPhraseValidation,
  Argon2Params
} from '@shared/contracts/crypto'

export {
  CRYPTO_VERSION,
  DEFAULT_ARGON2_PARAMS,
  HKDF_CONTEXTS,
  KEYCHAIN_KEYS
} from '@shared/contracts/crypto'
