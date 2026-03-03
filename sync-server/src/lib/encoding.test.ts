import { describe, it, expect } from 'vitest'

import { AppError, ErrorCodes } from '../lib/errors'

import { safeBase64Decode, verifyEd25519 } from './encoding'

// ============================================================================
// Tests: safeBase64Decode
// ============================================================================

describe('safeBase64Decode', () => {
  it('should decode valid base64 to correct bytes', () => {
    // #given
    const input = btoa('hello')

    // #when
    const result = safeBase64Decode(input)

    // #then
    expect(result).toBeInstanceOf(Uint8Array)
    expect(Array.from(result)).toEqual([104, 101, 108, 108, 111])
  })

  it('should return empty Uint8Array for empty string', () => {
    // #when
    const result = safeBase64Decode('')

    // #then
    expect(result).toBeInstanceOf(Uint8Array)
    expect(result.length).toBe(0)
  })

  it('should throw AppError with VALIDATION_ERROR on invalid base64', () => {
    // #given
    const invalid = '!!!invalid!!!'

    // #when / #then
    expect(() => safeBase64Decode(invalid)).toThrow(AppError)

    try {
      safeBase64Decode(invalid)
    } catch (e) {
      expect((e as AppError).code).toBe(ErrorCodes.VALIDATION_ERROR)
      expect((e as AppError).statusCode).toBe(400)
      expect((e as AppError).message).toBe('Malformed base64 input')
    }
  })
})

// ============================================================================
// Tests: verifyEd25519
// ============================================================================

describe('verifyEd25519', () => {
  it('should throw on malformed base64 public key', async () => {
    // #given
    const badKey = '!!!not-base64!!!'
    const validSig = btoa('signature-bytes')
    const payload = new Uint8Array([1, 2, 3])

    // #when / #then
    await expect(verifyEd25519(badKey, validSig, payload)).rejects.toThrow(AppError)

    try {
      await verifyEd25519(badKey, validSig, payload)
    } catch (e) {
      expect((e as AppError).code).toBe(ErrorCodes.VALIDATION_ERROR)
    }
  })

  it('should throw on malformed base64 signature', async () => {
    // #given
    const validKey = btoa('some-key-bytes')
    const badSig = '!!!not-base64!!!'
    const payload = new Uint8Array([1, 2, 3])

    // #when / #then
    await expect(verifyEd25519(validKey, badSig, payload)).rejects.toThrow(AppError)

    try {
      await verifyEd25519(validKey, badSig, payload)
    } catch (e) {
      expect((e as AppError).code).toBe(ErrorCodes.VALIDATION_ERROR)
    }
  })
})
