/**
 * CBOR Module Tests
 *
 * Tests canonical CBOR encoding for cryptographic signatures.
 * Ensures RFC 8949 Section 4.2 compliance for deterministic encoding.
 *
 * @module main/crypto/cbor.test
 */

import { describe, it, expect } from 'vitest'
import {
  canonicalEncode,
  canonicalDecode,
  createSignaturePayload,
  createLinkingHmacPayload
} from './cbor'
import {
  TEST_SIMPLE_OBJECT,
  TEST_SIMPLE_OBJECT_REORDERED,
  TEST_NESTED_OBJECT,
  TEST_VARIED_KEYS,
  TEST_SIGNATURE_PAYLOAD,
  TEST_SIGNATURE_PAYLOAD_WITH_METADATA,
  TEST_LINKING_PAYLOAD
} from './__fixtures__'
import { expectBufferEqual } from './__helpers__'

describe('cbor', () => {
  describe('canonicalEncode', () => {
    it('should encode simple objects to CBOR bytes', () => {
      const bytes = canonicalEncode(TEST_SIMPLE_OBJECT)

      expect(bytes).toBeInstanceOf(Uint8Array)
      expect(bytes.length).toBeGreaterThan(0)
    })

    it('should produce identical bytes for same data regardless of key order', () => {
      const bytes1 = canonicalEncode(TEST_SIMPLE_OBJECT)
      const bytes2 = canonicalEncode(TEST_SIMPLE_OBJECT_REORDERED)

      expectBufferEqual(bytes1, bytes2)
    })

    it('should sort keys by length first (shorter first)', () => {
      // Keys: a (1), id (2), bb (2), type (4), nonce (5), version (7)
      const bytes = canonicalEncode(TEST_VARIED_KEYS)
      const decoded = canonicalDecode<Record<string, string>>(bytes)

      // Keys should be sorted by length first
      const keys = Object.keys(decoded)
      expect(keys[0]).toBe('a') // 1 char
      // Then alphabetically for same length
      expect(keys.slice(1, 3).sort()).toEqual(['bb', 'id']) // both 2 chars
    })

    it('should sort keys alphabetically when same length', () => {
      const obj = { zz: 1, aa: 2, mm: 3 }
      const bytes = canonicalEncode(obj)
      const decoded = canonicalDecode<Record<string, number>>(bytes)

      const keys = Object.keys(decoded)
      expect(keys).toEqual(['aa', 'mm', 'zz'])
    })

    it('should handle nested objects', () => {
      const bytes = canonicalEncode(TEST_NESTED_OBJECT)
      const decoded = canonicalDecode(bytes)

      expect(decoded).toEqual(TEST_NESTED_OBJECT)
    })

    it('should handle arrays', () => {
      const arr = [1, 'two', { three: 3 }, [4, 5]]
      const bytes = canonicalEncode(arr)
      const decoded = canonicalDecode(bytes)

      expect(decoded).toEqual(arr)
    })

    it('should handle numbers (integers and floats)', () => {
      const obj = {
        int: 42,
        negative: -100,
        float: 3.14159,
        zero: 0,
        large: 9007199254740991 // MAX_SAFE_INTEGER
      }
      const bytes = canonicalEncode(obj)
      const decoded = canonicalDecode(bytes)

      expect(decoded).toEqual(obj)
    })

    it('should handle empty objects', () => {
      const bytes = canonicalEncode({})
      const decoded = canonicalDecode(bytes)

      expect(decoded).toEqual({})
    })

    it('should handle Uint8Array values', () => {
      const obj = { data: new Uint8Array([1, 2, 3, 4, 5]) }
      const bytes = canonicalEncode(obj)
      const decoded = canonicalDecode<{ data: Uint8Array }>(bytes)

      expect(decoded.data).toEqual(new Uint8Array([1, 2, 3, 4, 5]))
    })

    it('should handle boolean values', () => {
      const obj = { yes: true, no: false }
      const bytes = canonicalEncode(obj)
      const decoded = canonicalDecode(bytes)

      expect(decoded).toEqual(obj)
    })

    it('should handle null values', () => {
      const obj = { value: null }
      const bytes = canonicalEncode(obj)
      const decoded = canonicalDecode(bytes)

      expect(decoded).toEqual(obj)
    })

    it('should handle empty strings', () => {
      const obj = { empty: '' }
      const bytes = canonicalEncode(obj)
      const decoded = canonicalDecode(bytes)

      expect(decoded).toEqual(obj)
    })

    it('should produce deterministic output on multiple calls', () => {
      const results: Uint8Array[] = []

      for (let i = 0; i < 5; i++) {
        results.push(canonicalEncode(TEST_SIMPLE_OBJECT))
      }

      // All results should be identical
      for (let i = 1; i < results.length; i++) {
        expectBufferEqual(results[0], results[i])
      }
    })
  })

  describe('canonicalDecode', () => {
    it('should decode CBOR bytes back to original data', () => {
      const original = { test: 'data', num: 123 }
      const bytes = canonicalEncode(original)
      const decoded = canonicalDecode(bytes)

      expect(decoded).toEqual(original)
    })

    it('should be inverse of canonicalEncode', () => {
      const testCases = [{ a: 1, b: 2 }, [1, 2, 3], 'string', 42, true, null]

      for (const original of testCases) {
        const bytes = canonicalEncode(original)
        const decoded = canonicalDecode(bytes)
        expect(decoded).toEqual(original)
      }
    })

    it('should preserve types through round-trip', () => {
      const original = {
        str: 'hello',
        num: 42,
        bool: true,
        nil: null,
        arr: [1, 2, 3],
        obj: { nested: true }
      }

      const bytes = canonicalEncode(original)
      const decoded = canonicalDecode<typeof original>(bytes)

      expect(typeof decoded.str).toBe('string')
      expect(typeof decoded.num).toBe('number')
      expect(typeof decoded.bool).toBe('boolean')
      expect(decoded.nil).toBeNull()
      expect(Array.isArray(decoded.arr)).toBe(true)
      expect(typeof decoded.obj).toBe('object')
    })
  })

  describe('createSignaturePayload', () => {
    it('should create deterministic payload with required fields', () => {
      const bytes = createSignaturePayload(TEST_SIGNATURE_PAYLOAD)

      expect(bytes).toBeInstanceOf(Uint8Array)
      expect(bytes.length).toBeGreaterThan(0)
    })

    it('should include optional metadata when provided', () => {
      const bytes = createSignaturePayload(TEST_SIGNATURE_PAYLOAD_WITH_METADATA)
      const decoded = canonicalDecode<Record<string, unknown>>(bytes)

      expect(decoded).toHaveProperty('metadata')
    })

    it('should include optional operation when provided', () => {
      const payloadWithOp = {
        ...TEST_SIGNATURE_PAYLOAD,
        operation: 'create' as const
      }
      const bytes = createSignaturePayload(payloadWithOp)
      const decoded = canonicalDecode<Record<string, unknown>>(bytes)

      expect(decoded).toHaveProperty('operation', 'create')
    })

    it('should produce identical bytes for identical inputs', () => {
      const bytes1 = createSignaturePayload(TEST_SIGNATURE_PAYLOAD)
      const bytes2 = createSignaturePayload(TEST_SIGNATURE_PAYLOAD)

      expectBufferEqual(bytes1, bytes2)
    })

    it('should handle clock and fieldClocks in metadata', () => {
      const payload = {
        ...TEST_SIGNATURE_PAYLOAD,
        metadata: {
          clock: { 'device-1': 5, 'device-2': 3 },
          fieldClocks: {
            title: { 'device-1': 5 }
          }
        }
      }
      const bytes = createSignaturePayload(payload)
      const decoded = canonicalDecode<Record<string, unknown>>(bytes)

      expect(decoded.metadata).toEqual(payload.metadata)
    })

    it('should produce different bytes for different IDs', () => {
      const payload1 = { ...TEST_SIGNATURE_PAYLOAD, id: 'id-1' }
      const payload2 = { ...TEST_SIGNATURE_PAYLOAD, id: 'id-2' }

      const bytes1 = createSignaturePayload(payload1)
      const bytes2 = createSignaturePayload(payload2)

      expect(Buffer.from(bytes1).equals(Buffer.from(bytes2))).toBe(false)
    })

    it('should produce different bytes for different types', () => {
      const payload1 = { ...TEST_SIGNATURE_PAYLOAD, type: 'note' }
      const payload2 = { ...TEST_SIGNATURE_PAYLOAD, type: 'task' }

      const bytes1 = createSignaturePayload(payload1)
      const bytes2 = createSignaturePayload(payload2)

      expect(Buffer.from(bytes1).equals(Buffer.from(bytes2))).toBe(false)
    })

    it('should handle stateVector in metadata', () => {
      const payload = {
        ...TEST_SIGNATURE_PAYLOAD,
        metadata: {
          stateVector: 'some-state-vector-base64'
        }
      }
      const bytes = createSignaturePayload(payload)
      const decoded = canonicalDecode<Record<string, { stateVector: string }>>(bytes)

      expect(decoded.metadata.stateVector).toBe('some-state-vector-base64')
    })
  })

  describe('createLinkingHmacPayload', () => {
    it('should create deterministic payload for linking', () => {
      const bytes = createLinkingHmacPayload(TEST_LINKING_PAYLOAD)

      expect(bytes).toBeInstanceOf(Uint8Array)
      expect(bytes.length).toBeGreaterThan(0)
    })

    it('should handle optional fields', () => {
      const payloadWithAll = {
        ...TEST_LINKING_PAYLOAD,
        encryptedMasterKey: 'encrypted-master-key-base64',
        nonce: 'nonce-base64'
      }
      const bytes = createLinkingHmacPayload(payloadWithAll)
      const decoded = canonicalDecode<Record<string, string>>(bytes)

      expect(decoded).toHaveProperty('encryptedMasterKey')
      expect(decoded).toHaveProperty('nonce')
    })

    it('should always include sessionId', () => {
      const bytes = createLinkingHmacPayload({ sessionId: 'test-session' })
      const decoded = canonicalDecode<Record<string, string>>(bytes)

      expect(decoded).toHaveProperty('sessionId', 'test-session')
    })

    it('should produce identical bytes for identical inputs', () => {
      const bytes1 = createLinkingHmacPayload(TEST_LINKING_PAYLOAD)
      const bytes2 = createLinkingHmacPayload(TEST_LINKING_PAYLOAD)

      expectBufferEqual(bytes1, bytes2)
    })

    it('should produce different bytes for different sessionIds', () => {
      const payload1 = { ...TEST_LINKING_PAYLOAD, sessionId: 'session-1' }
      const payload2 = { ...TEST_LINKING_PAYLOAD, sessionId: 'session-2' }

      const bytes1 = createLinkingHmacPayload(payload1)
      const bytes2 = createLinkingHmacPayload(payload2)

      expect(Buffer.from(bytes1).equals(Buffer.from(bytes2))).toBe(false)
    })
  })

  describe('canonicalMapSorter (RFC 8949 compliance)', () => {
    it('should sort "id" before "type" (2 < 4 bytes)', () => {
      const obj = { type: 'x', id: 'y' }
      const bytes = canonicalEncode(obj)
      const decoded = canonicalDecode<Record<string, string>>(bytes)

      const keys = Object.keys(decoded)
      expect(keys.indexOf('id')).toBeLessThan(keys.indexOf('type'))
    })

    it('should sort "data" before "nonce" (same length, d < n)', () => {
      const obj = { nonce: 'x', data: 'y' }
      const bytes = canonicalEncode(obj)
      const decoded = canonicalDecode<Record<string, string>>(bytes)

      const keys = Object.keys(decoded)
      expect(keys.indexOf('data')).toBeLessThan(keys.indexOf('nonce'))
    })

    it('should handle numeric keys', () => {
      const obj = { 2: 'two', 1: 'one', 10: 'ten' }
      const bytes = canonicalEncode(obj)

      // Should decode without error
      const decoded = canonicalDecode(bytes)
      expect(decoded).toBeDefined()
    })

    it('should match RFC 8949 example ordering', () => {
      // RFC 8949 Section 4.2.1 specifies length-first ordering
      const obj = {
        b: 2, // 1 byte key
        aa: 3, // 2 byte key
        a: 1 // 1 byte key
      }
      const bytes = canonicalEncode(obj)
      const decoded = canonicalDecode<Record<string, number>>(bytes)

      const keys = Object.keys(decoded)
      // Should be: a (1 byte), b (1 byte, but b > a), aa (2 bytes)
      expect(keys[0]).toBe('a')
      expect(keys[1]).toBe('b')
      expect(keys[2]).toBe('aa')
    })
  })
})
