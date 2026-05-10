import { describe, expect, it } from 'vitest'
import {
  assertArgon2idVector,
  assertEd25519Vector,
  assertXChaCha20Vector,
  hexToBytes
} from './load-vectors'
import { ARGON2ID_RFC9106_VECTOR, ARGON2ID_RFC9106_VECTORS } from './argon2id-rfc9106'
import {
  ED25519_RFC8032_TEST_1,
  ED25519_RFC8032_TEST_2,
  ED25519_RFC8032_VECTORS
} from './ed25519-rfc8032'
import { XCHACHA20_RFC8439_DRAFT_VECTOR, XCHACHA20_RFC8439_VECTORS } from './xchacha20-rfc8439'

const bytes = (length: number) => new Uint8Array(length).fill(7)

describe('crypto vector loader helpers', () => {
  it('converts whitespace-padded hex and rejects malformed hex strings', () => {
    expect(Array.from(hexToBytes('00 0f\n10'))).toEqual([0, 15, 16])
    expect(() => hexToBytes('abc')).toThrow('odd-length input')
    expect(() => hexToBytes('zz')).toThrow('non-hex characters')
  })

  it('validates XChaCha20 vector byte shapes', () => {
    const vector = {
      name: 'xchacha',
      source: 'fixture',
      retrievedAt: '2026-05-10',
      key: bytes(32),
      nonce: bytes(24),
      aad: bytes(1),
      plaintext: bytes(4),
      ciphertext: bytes(4),
      tag: bytes(16)
    }

    expect(assertXChaCha20Vector(vector)).toBe(vector)
    expect(() => assertXChaCha20Vector({ ...vector, key: bytes(31) })).toThrow(
      'field "key" failed shape check'
    )
    expect(() => assertXChaCha20Vector({ ...vector, ciphertext: bytes(3) })).toThrow(
      'field "ciphertext" failed shape check'
    )
    expect(() => assertXChaCha20Vector({ ...vector, aad: [] as unknown as Uint8Array })).toThrow(
      'field "aad" failed shape check'
    )
  })

  it('validates Ed25519 vector byte shapes', () => {
    const vector = {
      name: 'ed25519',
      source: 'fixture',
      retrievedAt: '2026-05-10',
      secretKeySeed: bytes(32),
      publicKey: bytes(32),
      message: bytes(3),
      signature: bytes(64)
    }

    expect(assertEd25519Vector(vector)).toBe(vector)
    expect(() => assertEd25519Vector({ ...vector, publicKey: bytes(31) })).toThrow(
      'field "publicKey" failed shape check'
    )
    expect(() =>
      assertEd25519Vector({ ...vector, message: 'msg' as unknown as Uint8Array })
    ).toThrow('field "message" failed shape check')
  })

  it('validates Argon2id vector byte shapes and positive integer parameters', () => {
    const vector = {
      name: 'argon2id',
      source: 'fixture',
      retrievedAt: '2026-05-10',
      password: bytes(4),
      salt: bytes(16),
      secret: bytes(0),
      associatedData: bytes(0),
      parallelism: 1,
      tagLength: 32,
      memoryKiB: 64,
      iterations: 3,
      version: 19,
      tag: bytes(32)
    }

    expect(assertArgon2idVector(vector)).toBe(vector)
    expect(() => assertArgon2idVector({ ...vector, parallelism: 0 })).toThrow(
      'field "parallelism" failed shape check'
    )
    expect(() => assertArgon2idVector({ ...vector, iterations: 1.5 })).toThrow(
      'field "iterations" failed shape check'
    )
    expect(() => assertArgon2idVector({ ...vector, tag: bytes(31) })).toThrow(
      'field "tag" failed shape check'
    )
  })

  it('loads bundled RFC vectors with pinned byte shapes', () => {
    expect(ED25519_RFC8032_VECTORS).toHaveLength(2)
    expect(ED25519_RFC8032_TEST_1.message).toHaveLength(0)
    expect(ED25519_RFC8032_TEST_2.signature).toHaveLength(64)

    expect(XCHACHA20_RFC8439_VECTORS).toEqual([XCHACHA20_RFC8439_DRAFT_VECTOR])
    expect(XCHACHA20_RFC8439_DRAFT_VECTOR.nonce).toHaveLength(24)
    expect(XCHACHA20_RFC8439_DRAFT_VECTOR.tag).toHaveLength(16)

    expect(ARGON2ID_RFC9106_VECTORS).toEqual([ARGON2ID_RFC9106_VECTOR])
    expect(ARGON2ID_RFC9106_VECTOR.parallelism).toBe(4)
    expect(ARGON2ID_RFC9106_VECTOR.tag).toHaveLength(32)
  })
})
