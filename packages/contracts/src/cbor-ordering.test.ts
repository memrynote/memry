/**
 * CBOR Field-Ordering Contract Tests
 *
 * cbor-ordering.ts declares the canonical field orderings that producers
 * must use when encoding CBOR-signed payloads. There is no sort function
 * exported — the value of the module is the CBOR_FIELD_ORDER table
 * itself. These tests lock the table down so any accidental reordering
 * fails CI (signed CBOR bytes would otherwise diverge across devices
 * with the same logical input).
 */

import { describe, expect, it } from 'vitest'
import { CBOR_FIELD_ORDER } from './cbor-ordering'

describe('CBOR_FIELD_ORDER', () => {
  it('exposes all expected payload categories', () => {
    const keys = Object.keys(CBOR_FIELD_ORDER).sort()
    expect(keys).toEqual(
      [
        'SYNC_ITEM',
        'TOMBSTONE',
        'LINKING_PROOF',
        'SCAN_CONFIRM',
        'KEY_CONFIRM',
        'ATTACHMENT_MANIFEST'
      ].sort()
    )
  })

  it('pins the SYNC_ITEM field order (signature would break on drift)', () => {
    expect(CBOR_FIELD_ORDER.SYNC_ITEM).toEqual([
      'id',
      'type',
      'operation',
      'cryptoVersion',
      'encryptedKey',
      'keyNonce',
      'encryptedData',
      'dataNonce',
      'deletedAt',
      'metadata'
    ])
  })

  it('pins the TOMBSTONE field order', () => {
    expect(CBOR_FIELD_ORDER.TOMBSTONE).toEqual(['id', 'type', 'deletedAt', 'deviceId'])
  })

  it('pins the LINKING_PROOF field order', () => {
    expect(CBOR_FIELD_ORDER.LINKING_PROOF).toEqual(['sessionId', 'devicePublicKey'])
  })

  it('pins the SCAN_CONFIRM field order', () => {
    expect(CBOR_FIELD_ORDER.SCAN_CONFIRM).toEqual([
      'sessionId',
      'initiatorPublicKey',
      'devicePublicKey'
    ])
  })

  it('pins the KEY_CONFIRM field order', () => {
    expect(CBOR_FIELD_ORDER.KEY_CONFIRM).toEqual(['sessionId', 'encryptedMasterKey'])
  })

  it('pins the ATTACHMENT_MANIFEST field order', () => {
    expect(CBOR_FIELD_ORDER.ATTACHMENT_MANIFEST).toEqual([
      'encryptedManifest',
      'manifestNonce',
      'encryptedFileKey',
      'keyNonce'
    ])
  })

  it('contains no duplicate field names within any payload category', () => {
    for (const [category, fields] of Object.entries(CBOR_FIELD_ORDER)) {
      const unique = new Set(fields)
      expect(unique.size, `duplicate field in ${category}`).toBe(fields.length)
    }
  })

  it('produces deterministic byte output when the same ordering is applied to reordered inputs', () => {
    // Simulates what a deterministic CBOR encoder does: it must produce the
    // same JSON (and therefore the same downstream bytes) regardless of the
    // caller's insertion order, as long as the canonical ordering is followed.
    const canonicalSerialize = (input: Record<string, unknown>, order: readonly string[]): string =>
      JSON.stringify(
        order.reduce<Record<string, unknown>>((acc, field) => {
          if (field in input) acc[field] = input[field]
          return acc
        }, {})
      )

    const orderA = {
      id: 'n1',
      type: 'note',
      operation: 'update',
      cryptoVersion: 1,
      encryptedKey: 'ek',
      keyNonce: 'kn',
      encryptedData: 'ed',
      dataNonce: 'dn'
    }
    const orderB = {
      dataNonce: 'dn',
      encryptedData: 'ed',
      keyNonce: 'kn',
      encryptedKey: 'ek',
      cryptoVersion: 1,
      operation: 'update',
      type: 'note',
      id: 'n1'
    }

    const bytesA = canonicalSerialize(orderA, CBOR_FIELD_ORDER.SYNC_ITEM)
    const bytesB = canonicalSerialize(orderB, CBOR_FIELD_ORDER.SYNC_ITEM)
    expect(bytesA).toBe(bytesB)
  })
})
