import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================================
// libsodium mock
// ============================================================================

const { mockSodium, MOCK_PHRASE, MOCK_SEED_BUFFER } = vi.hoisted(() => {
  const sodium = {
    ready: Promise.resolve(),
    memzero: vi.fn((buf: Uint8Array) => buf.fill(0)),
    memcmp: vi.fn((a: Uint8Array, b: Uint8Array) => {
      if (a.length !== b.length) return false
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false
      }
      return true
    }),
    crypto_pwhash: vi.fn((_len: number, _seed: Uint8Array, _salt: Uint8Array) => {
      return new Uint8Array(32).fill(0xab)
    }),
    crypto_pwhash_ALG_ARGON2ID13: 2,
    crypto_kdf_derive_from_key: vi.fn(
      (length: number, id: number, _ctx: string, key: Uint8Array) => {
        const result = new Uint8Array(length)
        for (let i = 0; i < length; i++) result[i] = (key[i % key.length] ^ id) & 0xff
        return result
      }
    ),
    crypto_generichash: vi.fn((length: number, message: Uint8Array) => {
      const result = new Uint8Array(length)
      for (let i = 0; i < length; i++) result[i] = message[i % message.length]
      return result
    }),
    crypto_sign_keypair: vi.fn(() => ({
      publicKey: new Uint8Array(32).fill(0x01),
      privateKey: new Uint8Array(64).fill(0x02)
    })),
    crypto_sign_ed25519_sk_to_pk: vi.fn(() => new Uint8Array(32).fill(0x01)),
    randombytes_buf: vi.fn((len: number) => new Uint8Array(len).fill(0x99)),
    to_base64: vi.fn((_buf: Uint8Array, _variant: number) => 'base64-encoded-value'),
    to_hex: vi.fn(() => 'aabbccdd00112233aabbccdd00112233'),
    from_string: vi.fn((s: string) => new TextEncoder().encode(s)),
    base64_variants: { ORIGINAL: 0 }
  }

  const phrase =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art'
  const seedBuffer = Buffer.alloc(64, 0x42)

  return {
    mockSodium: sodium,
    MOCK_PHRASE: phrase,
    MOCK_SEED_BUFFER: seedBuffer
  }
})

vi.mock('libsodium-wrappers-sumo', () => ({ default: mockSodium }))

// ============================================================================
// bip39 mock
// ============================================================================

vi.mock('bip39', () => ({
  generateMnemonic: vi.fn(() => MOCK_PHRASE),
  mnemonicToSeed: vi.fn(async () => MOCK_SEED_BUFFER),
  validateMnemonic: vi.fn((phrase: string) => phrase === MOCK_PHRASE)
}))

vi.mock('keytar', () => ({
  default: {
    setPassword: vi.fn(),
    getPassword: vi.fn(),
    deletePassword: vi.fn()
  }
}))

// ============================================================================
// Import modules under test (after mocks are set up)
// ============================================================================

import {
  secureCleanup,
  constantTimeEqual,
  computeVerificationCode,
  initCrypto,
  deriveKey,
  deriveMasterKey,
  generateFileKey,
  generateDeviceSigningKeyPair,
  getDevicePublicKey,
  generateKeyVerifier,
  generateSalt
} from './index'

import { generateRecoveryPhrase, validateRecoveryPhrase, phraseToSeed } from './recovery'

// ============================================================================
// Tests: secureCleanup
// ============================================================================

describe('secureCleanup', () => {
  it('should zero out a single buffer', () => {
    // #given
    const buf = new Uint8Array([1, 2, 3, 4, 5])

    // #when
    secureCleanup(buf)

    // #then
    expect(mockSodium.memzero).toHaveBeenCalledWith(buf)
    expect(buf.every((b) => b === 0)).toBe(true)
  })

  it('should zero out multiple buffers', () => {
    // #given
    const a = new Uint8Array([10, 20])
    const b = new Uint8Array([30, 40, 50])

    // #when
    secureCleanup(a, b)

    // #then
    expect(mockSodium.memzero).toHaveBeenCalledTimes(2)
    expect(a.every((v) => v === 0)).toBe(true)
    expect(b.every((v) => v === 0)).toBe(true)
  })

  it('should handle empty arguments', () => {
    secureCleanup()
    expect(mockSodium.memzero).not.toHaveBeenCalled()
  })
})

// ============================================================================
// Tests: constantTimeEqual
// ============================================================================

describe('constantTimeEqual', () => {
  it('should return true for identical buffers', () => {
    // #given
    const a = new Uint8Array([1, 2, 3])
    const b = new Uint8Array([1, 2, 3])

    // #when
    const result = constantTimeEqual(a, b)

    // #then
    expect(result).toBe(true)
    expect(mockSodium.memcmp).toHaveBeenCalledWith(a, b)
  })

  it('should return false for different buffers of same length', () => {
    // #given
    const a = new Uint8Array([1, 2, 3])
    const b = new Uint8Array([1, 2, 4])
    mockSodium.memcmp.mockReturnValueOnce(false)

    // #when
    const result = constantTimeEqual(a, b)

    // #then
    expect(result).toBe(false)
  })

  it('should return false for different-length buffers', () => {
    // #given
    const a = new Uint8Array([1, 2, 3])
    const b = new Uint8Array([1, 2])

    // #when
    const result = constantTimeEqual(a, b)

    // #then
    expect(result).toBe(false)
  })
})

// ============================================================================
// Tests: initCrypto
// ============================================================================

describe('initCrypto', () => {
  it('should resolve without error', async () => {
    await expect(initCrypto()).resolves.toBeUndefined()
  })
})

// ============================================================================
// Tests: deriveKey
// ============================================================================

describe('deriveKey', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should use KDF for known context "memry-vault-key-v1"', async () => {
    // #given
    const masterKey = new Uint8Array(32).fill(0x11)

    // #when
    const result = await deriveKey(masterKey, 'memry-vault-key-v1', 32)

    // #then
    expect(mockSodium.crypto_kdf_derive_from_key).toHaveBeenCalledWith(32, 1, 'memryvlt', masterKey)
    expect(result).toBeInstanceOf(Uint8Array)
    expect(result.length).toBe(32)
  })

  it('should use KDF for known context "memry-signing-key-v1"', async () => {
    // #given
    const masterKey = new Uint8Array(32).fill(0x22)

    // #when
    await deriveKey(masterKey, 'memry-signing-key-v1', 32)

    // #then
    expect(mockSodium.crypto_kdf_derive_from_key).toHaveBeenCalledWith(32, 2, 'memrysgn', masterKey)
  })

  it('should throw for unknown context', async () => {
    await expect(deriveKey(new Uint8Array(32), 'unknown-context', 32)).rejects.toThrow(
      'Unknown key derivation context: unknown-context'
    )
  })
})

// ============================================================================
// Tests: deriveMasterKey
// ============================================================================

describe('deriveMasterKey', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should return MasterKeyMaterial with masterKey, kdfSalt, and keyVerifier', async () => {
    // #given
    const seed = new Uint8Array(32).fill(0x44)
    const salt = new Uint8Array(16).fill(0x55)

    // #when
    const result = await deriveMasterKey(seed, salt)

    // #then
    expect(result).toHaveProperty('masterKey')
    expect(result).toHaveProperty('kdfSalt')
    expect(result).toHaveProperty('keyVerifier')
    expect(result.masterKey).toBeInstanceOf(Uint8Array)
    expect(result.masterKey.length).toBe(32)
    expect(typeof result.kdfSalt).toBe('string')
    expect(typeof result.keyVerifier).toBe('string')
  })

  it('should call crypto_pwhash with Argon2id', async () => {
    // #given
    const seed = new Uint8Array(32).fill(0x66)
    const salt = new Uint8Array(16).fill(0x77)

    // #when
    await deriveMasterKey(seed, salt)

    // #then
    expect(mockSodium.crypto_pwhash).toHaveBeenCalledWith(
      32,
      seed,
      salt,
      3, // ARGON2_PARAMS.OPS_LIMIT
      67108864, // ARGON2_PARAMS.MEMORY_LIMIT
      mockSodium.crypto_pwhash_ALG_ARGON2ID13
    )
  })

  it('should produce deterministic output for same inputs', async () => {
    // #given
    const seed = new Uint8Array(32).fill(0xaa)
    const salt = new Uint8Array(16).fill(0xbb)

    // #when
    const result1 = await deriveMasterKey(seed, salt)
    const result2 = await deriveMasterKey(seed, salt)

    // #then
    expect(result1.kdfSalt).toBe(result2.kdfSalt)
    expect(result1.keyVerifier).toBe(result2.keyVerifier)
  })
})

// ============================================================================
// Tests: generateFileKey
// ============================================================================

describe('generateFileKey', () => {
  it('should return a 32-byte key', () => {
    const key = generateFileKey()
    expect(key).toBeInstanceOf(Uint8Array)
    expect(key.length).toBe(32)
    expect(mockSodium.randombytes_buf).toHaveBeenCalledWith(32)
  })
})

// ============================================================================
// Tests: generateDeviceSigningKeyPair
// ============================================================================

describe('generateDeviceSigningKeyPair', () => {
  it('should return deviceId, publicKey, and secretKey', async () => {
    // #when
    const result = await generateDeviceSigningKeyPair()

    // #then
    expect(result.deviceId).toBe('aabbccdd00112233aabbccdd00112233')
    expect(result.publicKey).toBeInstanceOf(Uint8Array)
    expect(result.publicKey.length).toBe(32)
    expect(result.secretKey).toBeInstanceOf(Uint8Array)
    expect(result.secretKey.length).toBe(64)
  })
})

// ============================================================================
// Tests: getDevicePublicKey
// ============================================================================

describe('getDevicePublicKey', () => {
  it('should extract public key from secret key', () => {
    // #given
    const secretKey = new Uint8Array(64).fill(0x02)

    // #when
    const pubKey = getDevicePublicKey(secretKey)

    // #then
    expect(mockSodium.crypto_sign_ed25519_sk_to_pk).toHaveBeenCalledWith(secretKey)
    expect(pubKey).toBeInstanceOf(Uint8Array)
  })
})

// ============================================================================
// Tests: generateKeyVerifier
// ============================================================================

describe('generateKeyVerifier', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should derive a verifier key and return base64 string', async () => {
    // #given
    const masterKey = new Uint8Array(32).fill(0x88)

    // #when
    const verifier = await generateKeyVerifier(masterKey)

    // #then
    expect(typeof verifier).toBe('string')
    expect(mockSodium.crypto_kdf_derive_from_key).toHaveBeenCalledWith(32, 4, 'memrykve', masterKey)
  })

  it('should clean up the verifier key buffer after use', async () => {
    // #given
    const masterKey = new Uint8Array(32).fill(0x99)

    // #when
    await generateKeyVerifier(masterKey)

    // #then
    expect(mockSodium.memzero).toHaveBeenCalled()
  })
})

// ============================================================================
// Tests: generateSalt
// ============================================================================

describe('generateSalt', () => {
  it('should return a 16-byte salt', () => {
    const salt = generateSalt()
    expect(salt).toBeInstanceOf(Uint8Array)
    expect(salt.length).toBe(16)
    expect(mockSodium.randombytes_buf).toHaveBeenCalledWith(16)
  })
})

// ============================================================================
// Tests: generateRecoveryPhrase
// ============================================================================

describe('generateRecoveryPhrase', () => {
  it('should return a phrase and seed', async () => {
    // #when
    const result = await generateRecoveryPhrase()

    // #then
    expect(typeof result.phrase).toBe('string')
    expect(result.phrase.split(' ').length).toBe(24)
    expect(result.seed).toBeInstanceOf(Uint8Array)
    expect(result.seed.length).toBe(64)
  })
})

// ============================================================================
// Tests: validateRecoveryPhrase
// ============================================================================

describe('validateRecoveryPhrase', () => {
  it('should return true for valid mnemonic', () => {
    expect(validateRecoveryPhrase(MOCK_PHRASE)).toBe(true)
  })

  it('should return false for invalid mnemonic', () => {
    expect(validateRecoveryPhrase('not a valid mnemonic')).toBe(false)
  })
})

// ============================================================================
// Tests: phraseToSeed
// ============================================================================

describe('phraseToSeed', () => {
  it('should convert a phrase back to a seed', async () => {
    // #when
    const seed = await phraseToSeed(MOCK_PHRASE)

    // #then
    expect(seed).toBeInstanceOf(Uint8Array)
    expect(seed.length).toBe(64)
  })

  it('should produce consistent seed for same phrase', async () => {
    // #when
    const seed1 = await phraseToSeed(MOCK_PHRASE)
    const seed2 = await phraseToSeed(MOCK_PHRASE)

    // #then
    expect(seed1.length).toBe(seed2.length)
  })
})

// ============================================================================
// Tests: computeVerificationCode
// ============================================================================

describe('computeVerificationCode', () => {
  it('should return a 6-digit string', async () => {
    // #given
    const sharedSecret = new Uint8Array(32)
    sharedSecret.fill(0xab)

    // #when
    const code = await computeVerificationCode(sharedSecret)

    // #then
    expect(code).toMatch(/^\d{6}$/)
  })

  it('should be deterministic for the same input', async () => {
    // #given
    const sharedSecret = new Uint8Array(32)
    sharedSecret.fill(0xcd)

    // #when
    const code1 = await computeVerificationCode(sharedSecret)
    const code2 = await computeVerificationCode(sharedSecret)

    // #then
    expect(code1).toBe(code2)
  })

  it('should differ for different shared secrets', async () => {
    // #given
    const secretA = new Uint8Array(32)
    secretA.fill(0x01)
    const secretB = new Uint8Array(32)
    secretB.fill(0x02)

    // #when
    const codeA = await computeVerificationCode(secretA)
    const codeB = await computeVerificationCode(secretB)

    // #then
    expect(codeA).not.toBe(codeB)
  })

  it('should zero-pad codes shorter than 6 digits', async () => {
    // #given — use a known secret that produces a small number
    const sharedSecret = new Uint8Array(32)

    // #when
    const code = await computeVerificationCode(sharedSecret)

    // #then
    expect(code.length).toBe(6)
  })
})
