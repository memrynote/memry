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
import {
  IETF_XCHACHA20_POLY1305_VECTOR,
  ONE_MIB_PLUS_ONE,
  buildPatternedPayload
} from './__fixtures__/encryption-extras'

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

  it('matches the IETF XChaCha20-Poly1305 golden vector for decrypt', () => {
    // #given the canonical draft-irtf-cfrg-xchacha-03 §A.3.1 vector
    const { key, nonce, aad, plaintext, ciphertext } = IETF_XCHACHA20_POLY1305_VECTOR

    // #when the pinned ciphertext is decrypted with the canonical inputs
    const recovered = decrypt(ciphertext, nonce, key, aad)

    // #then the recovered plaintext matches the canonical plaintext byte-for-byte
    expect(recovered).toEqual(plaintext)
  })

  it('produces deterministic ciphertext bytes when re-encrypted under the IETF golden vector', () => {
    // #given the canonical key/nonce/AAD/plaintext from the IETF vector
    const { key, nonce, aad, plaintext, ciphertext } = IETF_XCHACHA20_POLY1305_VECTOR

    // #when sodium re-runs the AEAD with the pinned nonce (bypassing generateNonce)
    const produced = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      plaintext,
      aad,
      null,
      nonce,
      key
    )

    // #then the bytes match the published vector exactly (catches AEAD param drift)
    expect(produced).toEqual(ciphertext)
  })

  it('fails when AAD is omitted on decrypt but supplied on encrypt', () => {
    // #given a payload encrypted with associated data
    const key = makeKey()
    const plaintext = encoder.encode('aad-required')
    const associatedData = encoder.encode('mandatory-aad')
    const { ciphertext, nonce } = encrypt(plaintext, key, associatedData)

    // #when decrypt is called without AAD
    // #then authentication fails with DECRYPTION_FAILED
    expectCryptoError(
      () => decrypt(ciphertext, nonce, key),
      'DECRYPTION_FAILED',
      /Ciphertext authentication failed:/
    )
  })

  it('fails when AAD is supplied on decrypt but omitted on encrypt', () => {
    // #given a payload encrypted without associated data
    const key = makeKey()
    const plaintext = encoder.encode('aad-not-bound')
    const { ciphertext, nonce } = encrypt(plaintext, key)

    // #when decrypt is called with non-empty AAD
    // #then authentication fails with DECRYPTION_FAILED
    expectCryptoError(
      () => decrypt(ciphertext, nonce, key, encoder.encode('unexpected-aad')),
      'DECRYPTION_FAILED',
      /Ciphertext authentication failed:/
    )
  })

  it('round-trips an empty Uint8Array via encrypt/decrypt', () => {
    // #given a zero-length plaintext
    const key = makeKey()
    const plaintext = new Uint8Array(0)

    // #when the empty payload round-trips
    const { ciphertext, nonce } = encrypt(plaintext, key)
    const recovered = decrypt(ciphertext, nonce, key)

    // #then the result is empty and the ciphertext carries only the auth tag
    expect(recovered).toHaveLength(0)
    expect(recovered).toEqual(plaintext)
    expect(ciphertext).toHaveLength(XCHACHA20_PARAMS.TAG_LENGTH)
  })

  it('round-trips a 1 MiB + 1 byte payload across the R2 chunk boundary', () => {
    // #given a payload one byte over the canonical 1 MiB threshold
    const key = makeKey()
    const plaintext = buildPatternedPayload(ONE_MIB_PLUS_ONE)
    const associatedData = encoder.encode('r2-chunk-boundary-plus-one')

    // #when the boundary-sized payload round-trips with AAD bound
    const { ciphertext, nonce } = encrypt(plaintext, key, associatedData)
    const recovered = decrypt(ciphertext, nonce, key, associatedData)

    // #then every byte survives and the ciphertext carries plaintext + auth tag
    expect(recovered).toHaveLength(ONE_MIB_PLUS_ONE)
    expect(recovered).toEqual(plaintext)
    expect(ciphertext.length).toBe(plaintext.length + XCHACHA20_PARAMS.TAG_LENGTH)
  })

  it('rejects unwrapping a file key with the wrong vault key', () => {
    // #given a file key wrapped under vault key A
    const vaultKeyA = makeKey()
    const vaultKeyB = makeKey()
    const fileKey = sodium.randombytes_buf(XCHACHA20_PARAMS.KEY_LENGTH)
    const { wrappedKey, nonce } = wrapFileKey(fileKey, vaultKeyA)

    // #when unwrap is attempted with vault key B
    // #then authentication fails (no silent recovery, no plaintext leak)
    expectCryptoError(
      () => unwrapFileKey(wrappedKey, nonce, vaultKeyB),
      'DECRYPTION_FAILED',
      /Ciphertext authentication failed:/
    )
  })

  it('rejects unwrapping a tampered wrapped file key', () => {
    // #given a file key wrapped under a vault key, then bit-flipped
    const vaultKey = makeKey()
    const fileKey = sodium.randombytes_buf(XCHACHA20_PARAMS.KEY_LENGTH)
    const { wrappedKey, nonce } = wrapFileKey(fileKey, vaultKey)
    const tampered = new Uint8Array(wrappedKey)
    tampered[tampered.length - 1] ^= 0x01

    // #when unwrap is attempted on the tampered wrapped key
    // #then the auth tag check fails
    expectCryptoError(
      () => unwrapFileKey(tampered, nonce, vaultKey),
      'DECRYPTION_FAILED',
      /Ciphertext authentication failed:/
    )
  })

  it('detects tampering on the master-key linking ciphertext', () => {
    // #given a master key encrypted for device linking
    const encKey = makeKey()
    const masterKey = sodium.randombytes_buf(XCHACHA20_PARAMS.KEY_LENGTH)
    const { ciphertext, nonce } = encryptMasterKeyForLinking(masterKey, encKey)
    const tampered = new Uint8Array(ciphertext)
    tampered[0] ^= 0xff

    // #when decryption is attempted on the tampered ciphertext
    // #then DECRYPTION_FAILED is raised — server-injected master keys cannot pass
    expectCryptoError(
      () => decryptMasterKeyFromLinking(tampered, nonce, encKey),
      'DECRYPTION_FAILED',
      /Ciphertext authentication failed:/
    )
  })

  it('rejects master-key linking decryption with the wrong ephemeral key', () => {
    // #given a master key encrypted under ephemeral key A
    const encKeyA = makeKey()
    const encKeyB = makeKey()
    const masterKey = sodium.randombytes_buf(XCHACHA20_PARAMS.KEY_LENGTH)
    const { ciphertext, nonce } = encryptMasterKeyForLinking(masterKey, encKeyA)

    // #when decryption is attempted with ephemeral key B
    // #then the channel rejects the wrong recipient
    expectCryptoError(
      () => decryptMasterKeyFromLinking(ciphertext, nonce, encKeyB),
      'DECRYPTION_FAILED',
      /Ciphertext authentication failed:/
    )
  })
})
