import { describe, expect, it } from 'vitest'

import { CBOR_FIELD_ORDER } from '@memry/contracts/cbor-ordering'
import { decodePayload, encodeCbor, encodeSignaturePayload } from './cbor'

describe('sync-server CBOR helpers', () => {
  it('rejects payloads with fields not declared in CBOR ordering', () => {
    expect(() =>
      encodeCbor(
        {
          id: 'item-1',
          type: 'task',
          encryptedData: 'cipher',
          dataNonce: 'nonce',
          encryptedKey: 'key',
          keyNonce: 'knonce',
          operation: 'create',
          cryptoVersion: 1,
          deletedAt: undefined,
          unexpected: 'drop-me'
        },
        CBOR_FIELD_ORDER.SYNC_ITEM
      )
    ).toThrow('CBOR encoding rejected')
  })

  it('encodes signature payload using shared sync-item ordering', () => {
    const payload = {
      id: 'item-1',
      type: 'task',
      operation: 'update',
      cryptoVersion: 1,
      encryptedKey: 'key',
      keyNonce: 'key-nonce',
      encryptedData: 'cipher',
      dataNonce: 'data-nonce'
    }

    const encoded = encodeSignaturePayload(payload)
    const decoded = decodePayload<Record<string, unknown>>(encoded)

    expect(decoded.id).toBe('item-1')
    expect(decoded.operation).toBe('update')
    expect(decoded.cryptoVersion).toBe(1)
  })
})
