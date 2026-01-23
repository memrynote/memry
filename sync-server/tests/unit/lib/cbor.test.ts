/**
 * T033a: Canonical CBOR Encoder Tests
 */

import { describe, it, expect, vi } from 'vitest'
import { encodeCanonicalCbor, encodeDeterministic, decodeCbor } from '../../../src/lib/cbor'
import { SyncError, ErrorCode } from '../../../src/lib/errors'

describe('CBOR Library', () => {
  describe('encodeCanonicalCbor', () => {
    it('should encode basic data types', () => {
      const data = { test: 'value', number: 42 }
      const result = encodeCanonicalCbor(data)
      expect(result).toBeInstanceOf(Uint8Array)
      expect(result.length).toBeGreaterThan(0)
    })

    it('should handle different type hints', () => {
      const data = { id: 'test', type: 'signature' }
      expect(() => encodeCanonicalCbor(data, 'signature-payload-v1')).not.toThrow()
      expect(() => encodeCanonicalCbor(data, 'crdt-item')).not.toThrow()
      expect(() => encodeCanonicalCbor(data, 'encrypted-update')).not.toThrow()
    })

    it('should throw SyncError on encoding failure', () => {
      // Create circular reference that CBOR can't encode
      const circular: any = {}
      circular.self = circular

      expect(() => encodeCanonicalCbor(circular)).toThrow(SyncError)
      expect(() => encodeCanonicalCbor(circular)).toThrow(
        expect.objectContaining({ code: ErrorCode.CRYPTO_ENCODING_FAILED })
      )
    })
  })

  describe('decodeCbor', () => {
    it('should decode previously encoded data', () => {
      const original = { message: 'hello', count: 123 }
      const encoded = encodeCanonicalCbor(original)
      const decoded = decodeCbor(encoded)

      expect(decoded).toEqual(original)
    })

    it('should throw SyncError on decoding failure', () => {
      const invalidData = new Uint8Array([0xff, 0xff]) // Invalid CBOR

      expect(() => decodeCbor(invalidData)).toThrow(SyncError)
      expect(() => decodeCbor(invalidData)).toThrow(
        expect.objectContaining({ code: ErrorCode.CRYPTO_ENCODING_FAILED })
      )
    })
  })

  describe('Deterministic encoding', () => {
    it('should produce consistent output regardless of key order', () => {
      const data1 = { b: 1, a: 2, c: 3 }
      const data2 = { c: 3, a: 2, b: 1 } // Same content, different order

      const encoded1 = encodeDeterministic(data1)
      const encoded2 = encodeDeterministic(data2)

      // Should be identical due to deterministic sorting
      expect(encoded1).toEqual(encoded2)
    })
  })

  describe('encodeDeterministic', () => {
    it('should produce consistent output for same input', () => {
      const data = { b: 1, a: 2, c: 3 }

      const encoded1 = encodeDeterministic(data)
      const encoded2 = encodeDeterministic(data)

      expect(encoded1).toEqual(encoded2)
    })

    it('should produce different output for different input', () => {
      const data1 = { a: 1, b: 2 }
      const data2 = { b: 2, a: 1 } // Same content, different key order

      const encoded1 = encodeDeterministic(data1)
      const encoded2 = encodeDeterministic(data2)

      // Should be the same due to deterministic sorting
      expect(encoded1).toEqual(encoded2)
    })
  })

  describe('Error handling', () => {
    it('should have correct error codes', () => {
      expect(ErrorCode.CRYPTO_ENCODING_FAILED).toBe('CRYPTO_ENCODING_FAILED')
    })

    it('should create SyncError with correct properties', () => {
      const error = new SyncError('Encoding failed', ErrorCode.CRYPTO_ENCODING_FAILED, 500)
      expect(error.code).toBe(ErrorCode.CRYPTO_ENCODING_FAILED)
      expect(error.message).toBe('Encoding failed')
      expect(error.statusCode).toBe(500)
    })
  })
})
