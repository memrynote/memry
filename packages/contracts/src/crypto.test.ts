/**
 * Crypto Contract Tests
 *
 * Zod schema + constant surface tests for the crypto contract:
 * EncryptedItem, EncryptedCrdtItem, SignaturePayloadV1 — plus
 * the parameter and keychain constant tables.
 *
 * The deletedAt-in-signature regression lock (Phase 1.3) lives
 * against signatures.ts; here we only assert the schema surface
 * (type-level: metadata and clock stay in the encrypted envelope
 * while deletedAt is a signature-level field, not a metadata one).
 */

import { describe, expect, it } from 'vitest'
import {
  ARGON2_PARAMS,
  CRYPTO_VERSION,
  ED25519_PARAMS,
  EncryptedCrdtItemSchema,
  EncryptedItemSchema,
  KEYCHAIN_ENTRIES,
  KEY_DERIVATION_CONTEXTS,
  LINKING_HKDF_CONTEXTS,
  SignaturePayloadV1Schema,
  X25519_PARAMS,
  XCHACHA20_PARAMS
} from './crypto'

const validEncryptedItem = {
  id: 'item-1',
  type: 'note' as const,
  cryptoVersion: 1,
  encryptedKey: 'ek',
  keyNonce: 'kn',
  encryptedData: 'ed',
  dataNonce: 'dn',
  signature: 'sig',
  signerDeviceId: 'dev-1'
}

const validCrdtItem = {
  id: 'note-1',
  type: 'note' as const,
  cryptoVersion: 1,
  encryptedSnapshot: 'snap',
  snapshotNonce: 'sn-nonce',
  stateVector: 'sv',
  encryptedKey: 'ek',
  keyNonce: 'kn',
  signature: 'sig',
  signerDeviceId: 'dev-1'
}

const validSignaturePayload = {
  id: 'item-1',
  type: 'note',
  cryptoVersion: CRYPTO_VERSION,
  encryptedKey: 'ek',
  keyNonce: 'kn',
  encryptedData: 'ed',
  dataNonce: 'dn'
}

describe('Crypto constants', () => {
  it('pins CRYPTO_VERSION to the current canonical value (1)', () => {
    expect(CRYPTO_VERSION).toBe(1)
  })

  it('documents the canonical Argon2id parameters (libsodium parallelism=1)', () => {
    expect(ARGON2_PARAMS.MEMORY_LIMIT).toBe(67108864)
    expect(ARGON2_PARAMS.OPS_LIMIT).toBe(3)
    expect(ARGON2_PARAMS.SALT_LENGTH).toBe(16)
  })

  it('documents the XChaCha20-Poly1305 nonce + tag lengths', () => {
    expect(XCHACHA20_PARAMS.NONCE_LENGTH).toBe(24)
    expect(XCHACHA20_PARAMS.KEY_LENGTH).toBe(32)
    expect(XCHACHA20_PARAMS.TAG_LENGTH).toBe(16)
  })

  it('documents Ed25519 key + signature lengths', () => {
    expect(ED25519_PARAMS.SEED_LENGTH).toBe(32)
    expect(ED25519_PARAMS.PUBLIC_KEY_LENGTH).toBe(32)
    expect(ED25519_PARAMS.SECRET_KEY_LENGTH).toBe(64)
    expect(ED25519_PARAMS.SIGNATURE_LENGTH).toBe(64)
  })

  it('documents X25519 lengths', () => {
    expect(X25519_PARAMS.PUBLIC_KEY_LENGTH).toBe(32)
    expect(X25519_PARAMS.SECRET_KEY_LENGTH).toBe(32)
    expect(X25519_PARAMS.SHARED_SECRET_LENGTH).toBe(32)
  })

  it('exposes the key-derivation contexts', () => {
    expect(KEY_DERIVATION_CONTEXTS.VAULT_KEY).toBe('memry-vault-key-v1')
    expect(KEY_DERIVATION_CONTEXTS.KEY_VERIFIER).toBe('memry-key-verifier-v1')
  })

  it('exposes the linking KDF contexts', () => {
    expect(LINKING_HKDF_CONTEXTS.ENCRYPTION).toBe('memry-linking-enc-v1')
    expect(LINKING_HKDF_CONTEXTS.MAC).toBe('memry-linking-mac-v1')
    expect(LINKING_HKDF_CONTEXTS.SAS).toBe('memry-linking-sas-v1')
  })

  it('pins all keychain entries to the memry service namespace', () => {
    for (const entry of Object.values(KEYCHAIN_ENTRIES)) {
      expect(entry.service).toBe('com.memry.sync')
      expect(entry.account.length).toBeGreaterThan(0)
    }
  })
})

describe('EncryptedItemSchema', () => {
  it('accepts a minimal valid item', () => {
    const result = EncryptedItemSchema.safeParse(validEncryptedItem)
    expect(result.success).toBe(true)
  })

  it('accepts an item with clock + fieldClocks + signedAt', () => {
    const result = EncryptedItemSchema.safeParse({
      ...validEncryptedItem,
      signedAt: 1700000000,
      clock: { 'dev-1': 1, 'dev-2': 3 },
      fieldClocks: {
        title: { 'dev-1': 2 }
      }
    })
    expect(result.success).toBe(true)
  })

  it('accepts every EncryptableItemType enum value', () => {
    const types = [
      'note',
      'task',
      'project',
      'settings',
      'inbox',
      'filter',
      'journal',
      'tag_definition',
      'folder_config',
      'calendar_event',
      'calendar_source',
      'calendar_binding',
      'calendar_external_event'
    ] as const
    for (const type of types) {
      const result = EncryptedItemSchema.safeParse({ ...validEncryptedItem, type })
      expect(result.success).toBe(true)
    }
  })

  it('rejects unknown type literal', () => {
    const result = EncryptedItemSchema.safeParse({ ...validEncryptedItem, type: 'bogus' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('type')
    }
  })

  it('rejects cryptoVersion below 1', () => {
    const result = EncryptedItemSchema.safeParse({ ...validEncryptedItem, cryptoVersion: 0 })
    expect(result.success).toBe(false)
  })

  it('rejects cryptoVersion above 99', () => {
    const result = EncryptedItemSchema.safeParse({ ...validEncryptedItem, cryptoVersion: 100 })
    expect(result.success).toBe(false)
  })

  it('rejects a non-integer cryptoVersion', () => {
    const result = EncryptedItemSchema.safeParse({ ...validEncryptedItem, cryptoVersion: 1.5 })
    expect(result.success).toBe(false)
  })

  it('rejects empty required string fields', () => {
    const fields = [
      'id',
      'encryptedKey',
      'keyNonce',
      'encryptedData',
      'dataNonce',
      'signature',
      'signerDeviceId'
    ] as const
    for (const field of fields) {
      const result = EncryptedItemSchema.safeParse({ ...validEncryptedItem, [field]: '' })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].path).toContain(field)
      }
    }
  })

  it('rejects a clock with negative ticks', () => {
    const result = EncryptedItemSchema.safeParse({
      ...validEncryptedItem,
      clock: { 'dev-1': -1 }
    })
    expect(result.success).toBe(false)
  })

  it('rejects a clock with non-integer ticks', () => {
    const result = EncryptedItemSchema.safeParse({
      ...validEncryptedItem,
      clock: { 'dev-1': 1.5 }
    })
    expect(result.success).toBe(false)
  })

  it('rejects fieldClocks with a negative tick inside a field', () => {
    const result = EncryptedItemSchema.safeParse({
      ...validEncryptedItem,
      fieldClocks: { title: { 'dev-1': -1 } }
    })
    expect(result.success).toBe(false)
  })
})

describe('EncryptedCrdtItemSchema', () => {
  it('accepts a valid CRDT item', () => {
    const result = EncryptedCrdtItemSchema.safeParse(validCrdtItem)
    expect(result.success).toBe(true)
  })

  it('rejects any type literal other than "note"', () => {
    const result = EncryptedCrdtItemSchema.safeParse({ ...validCrdtItem, type: 'journal' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('type')
    }
  })

  it('rejects missing stateVector', () => {
    const invalid: Record<string, unknown> = { ...validCrdtItem }
    delete invalid.stateVector
    const result = EncryptedCrdtItemSchema.safeParse(invalid)
    expect(result.success).toBe(false)
  })

  it('rejects empty encryptedSnapshot', () => {
    const result = EncryptedCrdtItemSchema.safeParse({ ...validCrdtItem, encryptedSnapshot: '' })
    expect(result.success).toBe(false)
  })

  it('rejects cryptoVersion out of the 1..99 range', () => {
    const low = EncryptedCrdtItemSchema.safeParse({ ...validCrdtItem, cryptoVersion: 0 })
    expect(low.success).toBe(false)

    const high = EncryptedCrdtItemSchema.safeParse({ ...validCrdtItem, cryptoVersion: 100 })
    expect(high.success).toBe(false)
  })
})

describe('SignaturePayloadV1Schema', () => {
  it('accepts a minimal valid payload', () => {
    const result = SignaturePayloadV1Schema.safeParse(validSignaturePayload)
    expect(result.success).toBe(true)
  })

  it('accepts an operation enum value', () => {
    const operations = ['create', 'update', 'delete'] as const
    for (const operation of operations) {
      const result = SignaturePayloadV1Schema.safeParse({ ...validSignaturePayload, operation })
      expect(result.success).toBe(true)
    }
  })

  it('rejects an unknown operation value', () => {
    const result = SignaturePayloadV1Schema.safeParse({
      ...validSignaturePayload,
      operation: 'archive'
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('operation')
    }
  })

  it('carries deletedAt at the top level (signature must cover deletion)', () => {
    const result = SignaturePayloadV1Schema.safeParse({
      ...validSignaturePayload,
      operation: 'delete',
      deletedAt: 1700000000
    })
    expect(result.success).toBe(true)
  })

  it('rejects metadata with invalid clock values', () => {
    const result = SignaturePayloadV1Schema.safeParse({
      ...validSignaturePayload,
      metadata: { clock: { 'dev-1': -1 } }
    })
    expect(result.success).toBe(false)
  })

  it('accepts metadata with a non-empty stateVector', () => {
    const result = SignaturePayloadV1Schema.safeParse({
      ...validSignaturePayload,
      metadata: { stateVector: 'sv' }
    })
    expect(result.success).toBe(true)
  })

  it('rejects metadata.stateVector when empty', () => {
    const result = SignaturePayloadV1Schema.safeParse({
      ...validSignaturePayload,
      metadata: { stateVector: '' }
    })
    expect(result.success).toBe(false)
  })

  it('rejects an unsupported cryptoVersion literal', () => {
    const result = SignaturePayloadV1Schema.safeParse({
      ...validSignaturePayload,
      cryptoVersion: 2
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('cryptoVersion')
    }
  })

  it('rejects empty id / type / required ciphertext fields', () => {
    const fields = ['id', 'type', 'encryptedKey', 'keyNonce', 'encryptedData', 'dataNonce'] as const
    for (const field of fields) {
      const result = SignaturePayloadV1Schema.safeParse({ ...validSignaturePayload, [field]: '' })
      expect(result.success).toBe(false)
    }
  })
})
