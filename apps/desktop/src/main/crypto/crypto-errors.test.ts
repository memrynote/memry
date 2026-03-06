import { beforeAll, describe, expect, it } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'

import { XCHACHA20_PARAMS } from '@memry/contracts/crypto'
import { CryptoError } from './crypto-errors'
import { decrypt, encrypt } from './encryption'

beforeAll(async () => {
  await sodium.ready
})

describe('CryptoError guards', () => {
  const validKey = (): Uint8Array => sodium.randombytes_buf(XCHACHA20_PARAMS.KEY_LENGTH)
  const plaintext = new TextEncoder().encode('test payload')

  describe('encrypt', () => {
    it('#given wrong key length #then throws INVALID_KEY_LENGTH', () => {
      // #given
      const shortKey = new Uint8Array(16)

      // #when / #then
      expect(() => encrypt(plaintext, shortKey)).toThrow(CryptoError)
      try {
        encrypt(plaintext, shortKey)
      } catch (err) {
        expect(err).toBeInstanceOf(CryptoError)
        expect((err as CryptoError).code).toBe('INVALID_KEY_LENGTH')
      }
    })

    it('#given valid key #then encrypts successfully', () => {
      // #given
      const key = validKey()

      // #when
      const result = encrypt(plaintext, key)

      // #then
      expect(result.ciphertext).toBeInstanceOf(Uint8Array)
      expect(result.nonce).toBeInstanceOf(Uint8Array)
      expect(result.nonce.length).toBe(XCHACHA20_PARAMS.NONCE_LENGTH)
    })
  })

  describe('decrypt', () => {
    it('#given wrong key length #then throws INVALID_KEY_LENGTH', () => {
      // #given
      const key = validKey()
      const { ciphertext, nonce } = encrypt(plaintext, key)
      const shortKey = new Uint8Array(16)

      // #when / #then
      expect(() => decrypt(ciphertext, nonce, shortKey)).toThrow(CryptoError)
      try {
        decrypt(ciphertext, nonce, shortKey)
      } catch (err) {
        expect(err).toBeInstanceOf(CryptoError)
        expect((err as CryptoError).code).toBe('INVALID_KEY_LENGTH')
      }
    })

    it('#given wrong nonce length #then throws INVALID_NONCE_LENGTH', () => {
      // #given
      const key = validKey()
      const { ciphertext } = encrypt(plaintext, key)
      const badNonce = new Uint8Array(12)

      // #when / #then
      expect(() => decrypt(ciphertext, badNonce, key)).toThrow(CryptoError)
      try {
        decrypt(ciphertext, badNonce, key)
      } catch (err) {
        expect(err).toBeInstanceOf(CryptoError)
        expect((err as CryptoError).code).toBe('INVALID_NONCE_LENGTH')
      }
    })

    it('#given corrupted ciphertext #then throws DECRYPTION_FAILED', () => {
      // #given
      const key = validKey()
      const { ciphertext, nonce } = encrypt(plaintext, key)
      ciphertext[0] ^= 0xff

      // #when / #then
      expect(() => decrypt(ciphertext, nonce, key)).toThrow(CryptoError)
      try {
        decrypt(ciphertext, nonce, key)
      } catch (err) {
        expect(err).toBeInstanceOf(CryptoError)
        expect((err as CryptoError).code).toBe('DECRYPTION_FAILED')
      }
    })

    it('#given wrong key #then throws DECRYPTION_FAILED', () => {
      // #given
      const key = validKey()
      const wrongKey = validKey()
      const { ciphertext, nonce } = encrypt(plaintext, key)

      // #when / #then
      expect(() => decrypt(ciphertext, nonce, wrongKey)).toThrow(CryptoError)
      try {
        decrypt(ciphertext, nonce, wrongKey)
      } catch (err) {
        expect(err).toBeInstanceOf(CryptoError)
        expect((err as CryptoError).code).toBe('DECRYPTION_FAILED')
      }
    })

    it('#given valid inputs #then decrypts successfully', () => {
      // #given
      const key = validKey()
      const { ciphertext, nonce } = encrypt(plaintext, key)

      // #when
      const result = decrypt(ciphertext, nonce, key)

      // #then
      expect(new TextDecoder().decode(result)).toBe('test payload')
    })
  })
})
