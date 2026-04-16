import { decode as cborDecode } from 'cborg'
import { beforeAll, describe, expect, it } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'

import { CBOR_FIELD_ORDER as CONTRACT_CBOR_FIELD_ORDER } from '@memry/contracts/cbor-ordering'

import { CBOR_FIELD_ORDER, encodeCbor } from './cbor'

beforeAll(async () => {
  await sodium.ready
})

const decode = (bytes: Uint8Array): Map<string, unknown> =>
  cborDecode(bytes, { useMaps: true }) as Map<string, unknown>

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

describe('encodeCbor', () => {
  it('re-exports the contracts CBOR_FIELD_ORDER reference', () => {
    // #given the cbor module re-exports the contract ordering
    // #then it must be the same reference (no shadowing)
    expect(CBOR_FIELD_ORDER).toBe(CONTRACT_CBOR_FIELD_ORDER)
  })

  it('produces deterministic bytes across 100 encode calls', () => {
    // #given a fixed payload
    const payload = {
      id: 'note-1',
      type: 'note',
      operation: 'upsert',
      cryptoVersion: 1,
      encryptedKey: new Uint8Array([1, 2, 3, 4]),
      keyNonce: new Uint8Array([5, 6, 7, 8]),
      encryptedData: new Uint8Array([9, 10, 11, 12]),
      dataNonce: new Uint8Array([13, 14, 15, 16]),
      deletedAt: null,
      metadata: { tag: 'demo' }
    }

    // #when encoded 100 times
    const first = encodeCbor(payload, CBOR_FIELD_ORDER.SYNC_ITEM)
    const allMatch = Array.from({ length: 100 }, () =>
      encodeCbor(payload, CBOR_FIELD_ORDER.SYNC_ITEM)
    ).every((bytes) => bytesEqual(bytes, first))

    // #then every output is byte-identical
    expect(allMatch).toBe(true)
  })

  it('emits every CBOR_FIELD_ORDER key even when the input is shuffled', () => {
    // #given input with keys in reverse order vs SYNC_ITEM
    const reversed: Record<string, unknown> = {}
    for (const key of [...CBOR_FIELD_ORDER.SYNC_ITEM].reverse()) {
      reversed[key] = `value-${key}`
    }

    // #when encoded with SYNC_ITEM order
    const encoded = encodeCbor(reversed, CBOR_FIELD_ORDER.SYNC_ITEM)
    const decoded = decode(encoded)

    // #then all SYNC_ITEM keys are present. cborg canonicalizes Map key
    // order per RFC 8949 §4.2.1 (length-first bytewise), so the decoded
    // order differs from CBOR_FIELD_ORDER — compare as sets.
    expect(new Set(decoded.keys())).toEqual(new Set(CBOR_FIELD_ORDER.SYNC_ITEM))
  })

  it('produces identical canonical bytes regardless of input key order', () => {
    // #given a nested signed payload in two different insertion orders
    const tombstone = {
      id: 'note-99',
      type: 'note',
      deletedAt: '2026-04-16T00:00:00Z',
      deviceId: 'device-A'
    }
    const tombstoneShuffled = {
      deviceId: tombstone.deviceId,
      deletedAt: tombstone.deletedAt,
      type: tombstone.type,
      id: tombstone.id
    }

    // #when both orderings are encoded
    const a = encodeCbor(tombstone, CBOR_FIELD_ORDER.TOMBSTONE)
    const b = encodeCbor(tombstoneShuffled, CBOR_FIELD_ORDER.TOMBSTONE)

    // #then bytes match (input insertion order does not affect output)
    expect(bytesEqual(a, b)).toBe(true)

    // #and every TOMBSTONE key round-trips through decode
    const decoded = decode(a)
    expect(new Set(decoded.keys())).toEqual(new Set(CBOR_FIELD_ORDER.TOMBSTONE))
  })

  it('skips fields whose value is undefined', () => {
    // #given a payload with two undefined fields
    const sparse = {
      id: 'note-2',
      type: undefined,
      operation: 'delete',
      cryptoVersion: undefined
    }

    // #when encoded
    const encoded = encodeCbor(sparse, CBOR_FIELD_ORDER.SYNC_ITEM)
    const decoded = decode(encoded) as Map<string, unknown>

    // #then only defined fields appear
    expect(Array.from(decoded.keys())).toEqual(['id', 'operation'])
    expect(decoded.get('id')).toBe('note-2')
    expect(decoded.get('operation')).toBe('delete')
  })

  it('rejects fields not in the supplied ordering', () => {
    // #given a payload with an unknown field
    const payload = {
      id: 'note-3',
      type: 'note',
      bogusField: 'should-not-appear',
      anotherExtra: 42
    }

    // #then encoding throws and lists every offending field
    expect(() => encodeCbor(payload, CBOR_FIELD_ORDER.SYNC_ITEM)).toThrow(
      /CBOR encoding rejected: fields not in ordering would be excluded: bogusField, anotherExtra/
    )
  })

  it('does not reject undefined values for unknown fields (filtered before extras check)', () => {
    // #given an unknown field with an undefined value
    const payload = {
      id: 'note-4',
      ghostField: undefined
    }

    // #when encoded — undefined-valued unknown keys are filtered out first
    const encoded = encodeCbor(payload, CBOR_FIELD_ORDER.SYNC_ITEM)
    const decoded = decode(encoded) as Map<string, unknown>

    // #then encoding succeeds and only `id` survives
    expect(Array.from(decoded.keys())).toEqual(['id'])
  })

  it('round-trips primitive value types via CBOR decode', () => {
    // #given a payload exercising string / number / bytes / null primitives
    const payload = {
      id: 'note-prim',
      type: 'note',
      operation: 'upsert',
      cryptoVersion: 7,
      encryptedKey: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      deletedAt: null
    }

    // #when round-tripped through cborg decode
    const decoded = decode(encodeCbor(payload, CBOR_FIELD_ORDER.SYNC_ITEM)) as Map<string, unknown>

    // #then every primitive survives intact
    expect(decoded.get('id')).toBe('note-prim')
    expect(decoded.get('type')).toBe('note')
    expect(decoded.get('operation')).toBe('upsert')
    expect(decoded.get('cryptoVersion')).toBe(7)
    expect(decoded.get('encryptedKey')).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))
    expect(decoded.get('deletedAt')).toBeNull()
  })

  it('round-trips boolean and nested-object values', () => {
    // #given metadata with boolean + nested object primitives
    const payload = {
      id: 'note-bool',
      metadata: { archived: true, pinned: false, child: { nested: 'yes' } }
    }

    // #when round-tripped
    const decoded = decode(encodeCbor(payload, CBOR_FIELD_ORDER.SYNC_ITEM)) as Map<string, unknown>

    // #then bool + nested object preserved
    const meta = decoded.get('metadata') as Map<string, unknown>
    expect(meta.get('archived')).toBe(true)
    expect(meta.get('pinned')).toBe(false)
    const child = meta.get('child') as Map<string, unknown>
    expect(child.get('nested')).toBe('yes')
  })

  it('produces an empty Map encoding when every field is undefined', () => {
    // #given a payload where all keys map to undefined
    const empty = { id: undefined, type: undefined }

    // #when encoded
    const encoded = encodeCbor(empty, CBOR_FIELD_ORDER.SYNC_ITEM)
    const decoded = decode(encoded) as Map<string, unknown>

    // #then result is an empty Map (no fields, no extras)
    expect(decoded.size).toBe(0)
  })

  it('works with every named ordering exported from CBOR_FIELD_ORDER', () => {
    // #given each ordering schema with a field-keyed payload
    for (const [name, fields] of Object.entries(CBOR_FIELD_ORDER)) {
      const payload: Record<string, unknown> = {}
      for (const field of fields) {
        payload[field] = `value-${field}`
      }

      // #when encoded
      const encoded = encodeCbor(payload, fields)
      const decoded = decode(encoded)

      // #then every field in the schema round-trips. cborg canonicalizes
      // Map order (RFC 8949 length-first), so compare as sets.
      expect(new Set(decoded.keys()), `ordering ${name}`).toEqual(new Set(fields))
    }
  })
})
