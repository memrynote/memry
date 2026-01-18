/**
 * Test Fixtures for Crypto Module
 *
 * Reusable test data for crypto tests. Uses deterministic values
 * for reproducible tests.
 *
 * @module main/crypto/__fixtures__
 */

// =============================================================================
// Recovery Phrases
// =============================================================================

/**
 * Valid 12-word BIP39 test phrase (standard test vector).
 * DO NOT use in production - this is publicly known!
 */
export const TEST_RECOVERY_PHRASE_12 =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

/**
 * Valid 24-word BIP39 test phrase.
 * DO NOT use in production - this is publicly known!
 */
export const TEST_RECOVERY_PHRASE_24 =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art'

/**
 * Invalid phrase (wrong checksum).
 */
export const INVALID_CHECKSUM_PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon'

/**
 * Invalid phrase (non-BIP39 word).
 */
export const INVALID_WORD_PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon xyz'

// =============================================================================
// Keys (Deterministic for Testing)
// =============================================================================

/**
 * Test master key (32 bytes).
 * Pattern: 0x42 repeated
 */
export const TEST_MASTER_KEY = Buffer.alloc(32, 0x42)

/**
 * Another test master key for comparison tests.
 * Pattern: 0x43 repeated
 */
export const TEST_MASTER_KEY_ALT = Buffer.alloc(32, 0x43)

/**
 * Test vault key (32 bytes).
 */
export const TEST_VAULT_KEY = Buffer.alloc(32, 0x44)

/**
 * Test file key (32 bytes).
 */
export const TEST_FILE_KEY = Buffer.alloc(32, 0x45)

/**
 * Test signing seed (32 bytes).
 */
export const TEST_SIGNING_SEED = Buffer.alloc(32, 0x46)

/**
 * Test HMAC key (32 bytes).
 */
export const TEST_HMAC_KEY = Buffer.alloc(32, 0x47)

// =============================================================================
// Nonces and Salts
// =============================================================================

/**
 * Test nonce for XChaCha20-Poly1305 (24 bytes).
 */
export const TEST_NONCE = Buffer.alloc(24, 0x01)

/**
 * Test KDF salt (16 bytes).
 */
export const TEST_SALT = Buffer.alloc(16, 0x02)

// =============================================================================
// Plaintext Data
// =============================================================================

/**
 * Simple test plaintext.
 */
export const TEST_PLAINTEXT = Buffer.from('Hello, World!', 'utf-8')

/**
 * Empty plaintext.
 */
export const EMPTY_PLAINTEXT = Buffer.alloc(0)

/**
 * Large plaintext (1MB).
 */
export function createLargePlaintext(sizeKB: number = 1024): Buffer {
  return Buffer.alloc(sizeKB * 1024, 0x55)
}

/**
 * Plaintext with null bytes and special characters.
 */
export const TEST_BINARY_DATA = Buffer.from([0x00, 0xff, 0x01, 0xfe, 0x02, 0xfd, 0x00, 0x00])

// =============================================================================
// Signature Payloads
// =============================================================================

/**
 * Standard signature payload for testing.
 */
export const TEST_SIGNATURE_PAYLOAD = {
  id: 'test-id-123',
  type: 'note',
  cryptoVersion: 1,
  encryptedKey: 'dGVzdC1lbmNyeXB0ZWQta2V5', // "test-encrypted-key" in base64
  keyNonce: 'dGVzdC1rZXktbm9uY2U=', // "test-key-nonce" in base64
  encryptedData: 'dGVzdC1lbmNyeXB0ZWQtZGF0YQ==', // "test-encrypted-data" in base64
  dataNonce: 'dGVzdC1kYXRhLW5vbmNl' // "test-data-nonce" in base64
}

/**
 * Signature payload with optional fields.
 */
export const TEST_SIGNATURE_PAYLOAD_WITH_METADATA = {
  ...TEST_SIGNATURE_PAYLOAD,
  operation: 'update' as const,
  metadata: {
    clock: { 'device-a': 1, 'device-b': 2 },
    fieldClocks: {
      title: { 'device-a': 1 },
      content: { 'device-b': 2 }
    }
  }
}

// =============================================================================
// Linking Payload
// =============================================================================

/**
 * Test linking HMAC payload.
 */
export const TEST_LINKING_PAYLOAD = {
  sessionId: 'test-session-123',
  token: 'test-token-456',
  newDevicePublicKey: 'dGVzdC1wdWJsaWMta2V5' // base64
}

// =============================================================================
// CBOR Test Data
// =============================================================================

/**
 * Simple object for CBOR testing.
 */
export const TEST_SIMPLE_OBJECT = {
  id: '123',
  type: 'note',
  data: 'hello'
}

/**
 * Object with keys in different order (should produce same CBOR).
 */
export const TEST_SIMPLE_OBJECT_REORDERED = {
  data: 'hello',
  type: 'note',
  id: '123'
}

/**
 * Nested object for CBOR testing.
 */
export const TEST_NESTED_OBJECT = {
  outer: {
    inner: {
      value: 42
    },
    array: [1, 2, 3]
  }
}

/**
 * Object with various key lengths for sorting tests.
 */
export const TEST_VARIED_KEYS = {
  id: '1', // 2 chars
  type: 'x', // 4 chars
  nonce: 'y', // 5 chars
  version: 'z', // 7 chars
  a: '1', // 1 char
  bb: '2' // 2 chars
}

// =============================================================================
// Keychain Test Data
// =============================================================================

/**
 * Test device ID.
 */
export const TEST_DEVICE_ID = 'test-device-uuid-12345'

/**
 * Test user ID.
 */
export const TEST_USER_ID = 'test-user-uuid-67890'

/**
 * Test access token.
 */
export const TEST_ACCESS_TOKEN = 'test-access-token-jwt-here'

/**
 * Test refresh token.
 */
export const TEST_REFRESH_TOKEN = 'test-refresh-token-here'
