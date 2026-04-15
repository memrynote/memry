import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'

import { XCHACHA20_PARAMS } from '@memry/contracts/crypto'

import { CryptoError } from './crypto-errors'
import {
  decrypt,
  decryptMasterKeyFromLinking,
  encrypt,
  encryptMasterKeyForLinking,
  generateNonce,
  unwrapFileKey,
  wrapFileKey
} from './encryption'

beforeAll(async () => {
  await sodium.ready
})

afterEach(() => {
  vi.restoreAllMocks()
})

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const makeKey = (): Uint8Array => sodium.randombytes_buf(XCHACHA20_PARAMS.KEY_LENGTH)

const makePayload = (length: number): Uint8Array => {
  const payload = new Uint8Array(length)
  for (let i = 0; i < payload.length; i++) {
    payload[i] = i % 251
  }
  return payload
}

const expectCryptoError = (fn: () => unknown, code: CryptoError['code'], message?: RegExp) => {
  try {
    fn()
    throw new Error('Expected CryptoError to be thrown')
  } catch (err) {
    expect(err).toBeInstanceOf(CryptoError)
    const cryptoError = err as CryptoError
    expect(cryptoError.code).toBe(code)
    if (message) {
      expect(cryptoError.message).toMatch(message)
    }
  }
}

describe('encryption', () => {
  it('round-trips a payload without associated data', () => {
    const key = makeKey()
    const plaintext = encoder.encode('hello, encryption')

    const { ciphertext, nonce } = encrypt(plaintext, key)
    const recovered = decrypt(ciphertext, nonce, key)

    expect(recovered).toEqual(plaintext)
  })

  it('round-trips a payload with associated data', () => {
    const key = makeKey()
    const plaintext = encoder.encode('hello, aad')
    const associatedData = encoder.encode('note-metadata')

    const { ciphertext, nonce } = encrypt(plaintext, key, associatedData)
    const recovered = decrypt(ciphertext, nonce, key, associatedData)

    expect(decoder.decode(recovered)).toBe('hello, aad')
  })

  it('rejects ciphertext tampering', () => {
    const key = makeKey()
    const plaintext = encoder.encode('tamper-me')
    const { ciphertext, nonce } = encrypt(plaintext, key)
    const tampered = new Uint8Array(ciphertext)
    tampered[0] ^= 0xff

    expectCryptoError(
      () => decrypt(tampered, nonce, key),
      'DECRYPTION_FAILED',
      /Ciphertext authentication failed:/
    )
  })

  it('rejects a wrong key of the correct length', () => {
    const key = makeKey()
    const wrongKey = makeKey()
    const plaintext = encoder.encode('wrong-key-test')
    const { ciphertext, nonce } = encrypt(plaintext, key)

    expectCryptoError(
      () => decrypt(ciphertext, nonce, wrongKey),
      'DECRYPTION_FAILED',
      /Ciphertext authentication failed:/
    )
  })

  it('rejects a wrong nonce of the correct length', () => {
    const key = makeKey()
    const plaintext = encoder.encode('wrong-nonce-test')
    const { ciphertext, nonce } = encrypt(plaintext, key)
    const wrongNonce = new Uint8Array(nonce)
    wrongNonce[0] ^= 0xff

    expectCryptoError(
      () => decrypt(ciphertext, wrongNonce, key),
      'DECRYPTION_FAILED',
      /Ciphertext authentication failed:/
    )
  })

  it('rejects associated data mismatches', () => {
    const key = makeKey()
    const plaintext = encoder.encode('aad-mismatch')
    const { ciphertext, nonce } = encrypt(plaintext, key, encoder.encode('aad-a'))

    expectCryptoError(
      () => decrypt(ciphertext, nonce, key, encoder.encode('aad-b')),
      'DECRYPTION_FAILED',
      /Ciphertext authentication failed:/
    )
  })

  it('round-trips a zero-length payload', () => {
    const key = makeKey()
    const plaintext = new Uint8Array()

    const { ciphertext, nonce } = encrypt(plaintext, key)
    const recovered = decrypt(ciphertext, nonce, key)

    expect(recovered).toEqual(plaintext)
    expect(recovered).toHaveLength(0)
  })

  it('round-trips a payload larger than 1 MiB', () => {
    const key = makeKey()
    const plaintext = makePayload(1024 * 1024 + 17)
    const associatedData = encoder.encode('r2-chunk-boundary')

    const { ciphertext, nonce } = encrypt(plaintext, key, associatedData)
    const recovered = decrypt(ciphertext, nonce, key, associatedData)

    expect(recovered).toEqual(plaintext)
    expect(ciphertext.length).toBeGreaterThan(plaintext.length)
  })

  it('wraps encryption failures as ENCRYPTION_FAILED', () => {
    const key = makeKey()
    const plaintext = encoder.encode('boom')
    const encryptSpy = vi
      .spyOn(sodium, 'crypto_aead_xchacha20poly1305_ietf_encrypt')
      .mockImplementation(() => {
        throw new Error('forced encryption failure')
      })

    expectCryptoError(
      () => encrypt(plaintext, key),
      'ENCRYPTION_FAILED',
      /forced encryption failure/
    )

    encryptSpy.mockRestore()
  })

  it('wraps non-error encryption failures as ENCRYPTION_FAILED', () => {
    const key = makeKey()
    const plaintext = encoder.encode('boom-string')
    const encryptSpy = vi
      .spyOn(sodium, 'crypto_aead_xchacha20poly1305_ietf_encrypt')
      .mockImplementation(() => {
        throw 'forced string failure'
      })

    expectCryptoError(() => encrypt(plaintext, key), 'ENCRYPTION_FAILED', /Encryption failed/)

    encryptSpy.mockRestore()
  })

  it('wraps non-authentication decrypt failures without a ciphertext prefix', () => {
    const key = makeKey()
    const plaintext = encoder.encode('decrypt-failure')
    const { ciphertext, nonce } = encrypt(plaintext, key)
    const decryptSpy = vi
      .spyOn(sodium, 'crypto_aead_xchacha20poly1305_ietf_decrypt')
      .mockImplementation(() => {
        throw new Error('forced decrypt failure')
      })

    expectCryptoError(() => decrypt(ciphertext, nonce, key), 'DECRYPTION_FAILED', /forced decrypt failure/)

    decryptSpy.mockRestore()
  })

  it('wraps non-Error decrypt failures as a generic decryption error', () => {
    const key = makeKey()
    const plaintext = encoder.encode('decrypt-non-error')
    const { ciphertext, nonce } = encrypt(plaintext, key)
    const decryptSpy = vi
      .spyOn(sodium, 'crypto_aead_xchacha20poly1305_ietf_decrypt')
      .mockImplementation(() => {
        throw 'forced string failure'
      })

    expectCryptoError(() => decrypt(ciphertext, nonce, key), 'DECRYPTION_FAILED', /Decryption failed/)

    decryptSpy.mockRestore()
  })

  it('throws when sodium returns a nonce with the wrong length', () => {
    const randombytesSpy = vi.spyOn(sodium, 'randombytes_buf').mockReturnValueOnce(
      new Uint8Array(XCHACHA20_PARAMS.NONCE_LENGTH - 1)
    )

    expect(() => generateNonce()).toThrow(
      `Nonce length mismatch: expected ${XCHACHA20_PARAMS.NONCE_LENGTH}, got ${XCHACHA20_PARAMS.NONCE_LENGTH - 1}`
    )

    randombytesSpy.mockRestore()
  })

  it('round-trips the master-key linking helpers', () => {
    const encKey = makeKey()
    const masterKey = makePayload(32)

    const { ciphertext, nonce } = encryptMasterKeyForLinking(masterKey, encKey)
    const recovered = decryptMasterKeyFromLinking(ciphertext, nonce, encKey)

    expect(recovered).toEqual(masterKey)
  })

  it('wraps and unwraps file keys while zeroing the intermediate buffer', () => {
    const vaultKey = makeKey()
    const fileKey = makePayload(32)
    const { wrappedKey, nonce } = wrapFileKey(fileKey, vaultKey)
    const memzeroSpy = vi.spyOn(sodium, 'memzero')

    const recovered = unwrapFileKey(wrappedKey, nonce, vaultKey)

    expect(recovered).toEqual(fileKey)
    expect(memzeroSpy).toHaveBeenCalledTimes(1)
    expect(memzeroSpy.mock.calls[0][0]).toBeInstanceOf(Uint8Array)
    expect(memzeroSpy.mock.calls[0][0]).toHaveLength(32)
  })

  it('rejects invalid key and nonce lengths', () => {
    const plaintext = encoder.encode('length-check')
    const validKey = makeKey()
    const shortKey = new Uint8Array(XCHACHA20_PARAMS.KEY_LENGTH - 1)
    const { ciphertext, nonce } = encrypt(plaintext, validKey)
    const shortNonce = new Uint8Array(XCHACHA20_PARAMS.NONCE_LENGTH - 1)

    expectCryptoError(
      () => encrypt(plaintext, shortKey),
      'INVALID_KEY_LENGTH'
    )
    expectCryptoError(
      () => decrypt(ciphertext, nonce, shortKey),
      'INVALID_KEY_LENGTH'
    )
    expectCryptoError(
      () => decrypt(ciphertext, shortNonce, validKey),
      'INVALID_NONCE_LENGTH'
    )
  })
})
