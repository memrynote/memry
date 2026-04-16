/**
 * IPC Crypto Contract Tests
 *
 * Zod schema validation tests for the crypto IPC boundary:
 * encrypt/decrypt requests, signature verification, and key rotation.
 */

import { describe, expect, it } from 'vitest'
import {
  CRYPTO_CHANNELS,
  DecryptItemSchema,
  EncryptItemSchema,
  RotateKeysSchema,
  VerifySignatureSchema
} from './ipc-crypto'

describe('CRYPTO_CHANNELS', () => {
  it('exposes every crypto channel literal', () => {
    expect(CRYPTO_CHANNELS.ENCRYPT_ITEM).toBe('crypto:encrypt-item')
    expect(CRYPTO_CHANNELS.DECRYPT_ITEM).toBe('crypto:decrypt-item')
    expect(CRYPTO_CHANNELS.VERIFY_SIGNATURE).toBe('crypto:verify-signature')
    expect(CRYPTO_CHANNELS.ROTATE_KEYS).toBe('crypto:rotate-keys')
    expect(CRYPTO_CHANNELS.GET_ROTATION_PROGRESS).toBe('crypto:get-rotation-progress')
  })
})

describe('EncryptItemSchema', () => {
  it('accepts minimal valid input', () => {
    const result = EncryptItemSchema.safeParse({
      itemId: 'item-1',
      type: 'note',
      content: { title: 'Hello' }
    })
    expect(result.success).toBe(true)
  })

  it('accepts full input with operation + deletedAt + metadata', () => {
    const result = EncryptItemSchema.safeParse({
      itemId: 'item-1',
      type: 'task',
      content: { title: 'Task' },
      operation: 'delete',
      deletedAt: 1700000000,
      metadata: { source: 'rotation' }
    })
    expect(result.success).toBe(true)
  })

  it('rejects an unknown type', () => {
    const result = EncryptItemSchema.safeParse({
      itemId: 'item-1',
      type: 'bookmark',
      content: {}
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('type')
    }
  })

  it('rejects content that is not a record', () => {
    const result = EncryptItemSchema.safeParse({
      itemId: 'item-1',
      type: 'note',
      content: 'raw-string'
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('content')
    }
  })

  it('rejects an unknown operation value', () => {
    const result = EncryptItemSchema.safeParse({
      itemId: 'item-1',
      type: 'note',
      content: {},
      operation: 'archive'
    })
    expect(result.success).toBe(false)
  })

  it('rejects empty itemId', () => {
    const result = EncryptItemSchema.safeParse({
      itemId: '',
      type: 'note',
      content: {}
    })
    expect(result.success).toBe(false)
  })
})

describe('DecryptItemSchema', () => {
  const base = {
    itemId: 'item-1',
    type: 'note' as const,
    encryptedKey: 'ek',
    keyNonce: 'kn',
    encryptedData: 'ed',
    dataNonce: 'dn',
    signature: 'sig'
  }

  it('accepts minimal valid input', () => {
    const result = DecryptItemSchema.safeParse(base)
    expect(result.success).toBe(true)
  })

  it('accepts optional operation + deletedAt + metadata', () => {
    const result = DecryptItemSchema.safeParse({
      ...base,
      operation: 'delete',
      deletedAt: 1700000000,
      metadata: { clock: { 'dev-1': 1 } }
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing signature — decryption must verify first', () => {
    const invalid: Record<string, unknown> = { ...base }
    delete invalid.signature
    const result = DecryptItemSchema.safeParse(invalid)
    expect(result.success).toBe(false)
  })

  it('rejects empty required ciphertext fields', () => {
    const fields = ['encryptedKey', 'keyNonce', 'encryptedData', 'dataNonce', 'signature'] as const
    for (const field of fields) {
      const result = DecryptItemSchema.safeParse({ ...base, [field]: '' })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].path).toContain(field)
      }
    }
  })
})

describe('VerifySignatureSchema', () => {
  const base = {
    itemId: 'item-1',
    type: 'note' as const,
    encryptedKey: 'ek',
    keyNonce: 'kn',
    encryptedData: 'ed',
    dataNonce: 'dn',
    signature: 'sig'
  }

  it('accepts minimal valid input', () => {
    const result = VerifySignatureSchema.safeParse(base)
    expect(result.success).toBe(true)
  })

  it('rejects an unknown sync type', () => {
    const result = VerifySignatureSchema.safeParse({ ...base, type: 'unknown' })
    expect(result.success).toBe(false)
  })

  it('rejects missing encryptedData', () => {
    const invalid: Record<string, unknown> = { ...base }
    delete invalid.encryptedData
    const result = VerifySignatureSchema.safeParse(invalid)
    expect(result.success).toBe(false)
  })
})

describe('RotateKeysSchema', () => {
  it('accepts confirm: true', () => {
    const result = RotateKeysSchema.safeParse({ confirm: true })
    expect(result.success).toBe(true)
  })

  it('accepts confirm: false', () => {
    const result = RotateKeysSchema.safeParse({ confirm: false })
    expect(result.success).toBe(true)
  })

  it('rejects a non-boolean confirm', () => {
    const result = RotateKeysSchema.safeParse({ confirm: 'yes' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('confirm')
    }
  })

  it('rejects missing confirm flag — rotation must be explicit', () => {
    const result = RotateKeysSchema.safeParse({})
    expect(result.success).toBe(false)
  })
})
