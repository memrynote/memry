import * as bip39 from 'bip39'
import sodium from 'libsodium-wrappers-sumo'
import { beforeAll, describe, expect, it } from 'vitest'

import { ARGON2_PARAMS } from '@memry/contracts/crypto'

import { deriveMasterKey } from './keys'
import {
  generateRecoveryPhrase,
  phraseToSeed,
  recoverMasterKeyFromPhrase,
  validateKeyVerifier,
  validateRecoveryPhrase
} from './recovery'

beforeAll(async () => {
  await sodium.ready
})

const englishWordSet = new Set(bip39.wordlists.english)

const makeSaltBytesAndB64 = (): { bytes: Uint8Array; b64: string } => {
  const bytes = sodium.randombytes_buf(ARGON2_PARAMS.SALT_LENGTH)
  return { bytes, b64: sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL) }
}

describe('generateRecoveryPhrase', () => {
  it('returns a 24-word BIP-39 phrase whose words are all in the English wordlist', async () => {
    // #given a freshly generated recovery phrase
    const result = await generateRecoveryPhrase()

    // #when splitting the phrase into words
    const words = result.phrase.split(' ')

    // #then it has 24 words, each in the BIP-39 English wordlist
    expect(words).toHaveLength(24)
    for (const word of words) {
      expect(englishWordSet.has(word)).toBe(true)
    }
  })

  it('produces a phrase that passes BIP-39 checksum validation', async () => {
    // #given a freshly generated recovery phrase
    const result = await generateRecoveryPhrase()

    // #then BIP-39 checksum validation accepts it
    expect(bip39.validateMnemonic(result.phrase)).toBe(true)
  })

  it('returns a 64-byte seed bound to the phrase', async () => {
    // #given a freshly generated recovery phrase
    const result = await generateRecoveryPhrase()

    // #when the seed is regenerated from the same phrase
    const seedAgain = await phraseToSeed(result.phrase)

    // #then the seed is 64 bytes and matches the deterministic derivation
    expect(result.seed).toBeInstanceOf(Uint8Array)
    expect(result.seed).toHaveLength(64)
    expect(seedAgain).toEqual(result.seed)
  })

  it('produces unique phrases on repeated calls', async () => {
    // #given two freshly generated recovery phrases
    const a = await generateRecoveryPhrase()
    const b = await generateRecoveryPhrase()

    // #then they differ (256-bit entropy — collision probability is negligible)
    expect(a.phrase).not.toBe(b.phrase)
  })
})

describe('validateRecoveryPhrase', () => {
  it('accepts a valid generated phrase', async () => {
    // #given a freshly generated recovery phrase
    const { phrase } = await generateRecoveryPhrase()

    // #then validation accepts it
    expect(validateRecoveryPhrase(phrase)).toBe(true)
  })

  it('rejects a phrase with a corrupted checksum word', async () => {
    // #given a generated phrase whose final (checksum) word is swapped for a different valid word
    const { phrase } = await generateRecoveryPhrase()
    const words = phrase.split(' ')
    const lastWord = words[words.length - 1]
    const replacement = lastWord === 'abandon' ? 'ability' : 'abandon'
    words[words.length - 1] = replacement

    // #then validation rejects the tampered phrase (checksum mismatch)
    expect(validateRecoveryPhrase(words.join(' '))).toBe(false)
  })

  it('rejects a phrase containing a word outside the BIP-39 wordlist', async () => {
    // #given a generated phrase with a non-wordlist token spliced in
    const { phrase } = await generateRecoveryPhrase()
    const words = phrase.split(' ')
    words[0] = 'notarealbip39word'

    // #then validation rejects the phrase
    expect(validateRecoveryPhrase(words.join(' '))).toBe(false)
  })

  it('rejects an empty string', () => {
    // #given an empty phrase
    // #then validation rejects it
    expect(validateRecoveryPhrase('')).toBe(false)
  })
})

describe('phraseToSeed', () => {
  it('is deterministic — same phrase always derives the same seed', async () => {
    // #given the same phrase
    const { phrase } = await generateRecoveryPhrase()

    // #when deriving twice
    const a = await phraseToSeed(phrase)
    const b = await phraseToSeed(phrase)

    // #then the seeds match exactly
    expect(a).toEqual(b)
    expect(a).toHaveLength(64)
  })

  it('produces different seeds for different phrases', async () => {
    // #given two different phrases
    const first = await generateRecoveryPhrase()
    const second = await generateRecoveryPhrase()

    // #when deriving seeds
    const seedA = await phraseToSeed(first.phrase)
    const seedB = await phraseToSeed(second.phrase)

    // #then the seeds differ
    expect(seedA).not.toEqual(seedB)
  })
})

describe('recoverMasterKeyFromPhrase', () => {
  it('round-trips: derive from generated seed → recover from phrase → keys match', async () => {
    // #given a recovery phrase, its seed, and a salt
    const { phrase, seed } = await generateRecoveryPhrase()
    const salt = makeSaltBytesAndB64()

    // #when deriving the master key directly and via recovery
    const direct = await deriveMasterKey(seed, salt.bytes)
    const recovered = await recoverMasterKeyFromPhrase(phrase, salt.b64)

    // #then both paths produce the same master key, salt, and verifier
    expect(recovered.masterKey).toEqual(direct.masterKey)
    expect(recovered.kdfSalt).toBe(direct.kdfSalt)
    expect(recovered.keyVerifier).toBe(direct.keyVerifier)
  })

  it('produces different master keys for different salts even with the same phrase', async () => {
    // #given one phrase and two distinct salts
    const { phrase } = await generateRecoveryPhrase()
    const saltA = makeSaltBytesAndB64()
    const saltB = makeSaltBytesAndB64()

    // #when recovering with each salt
    const recoveredA = await recoverMasterKeyFromPhrase(phrase, saltA.b64)
    const recoveredB = await recoverMasterKeyFromPhrase(phrase, saltB.b64)

    // #then the master keys differ — salt is mixed into the KDF
    expect(recoveredA.masterKey).not.toEqual(recoveredB.masterKey)
  })
})

describe('validateKeyVerifier', () => {
  it('returns true when both verifiers are byte-equal', async () => {
    // #given a verifier derived from a recovered master key
    const { phrase } = await generateRecoveryPhrase()
    const salt = makeSaltBytesAndB64()
    const recovered = await recoverMasterKeyFromPhrase(phrase, salt.b64)

    // #then comparison against itself succeeds
    expect(validateKeyVerifier(recovered.keyVerifier, recovered.keyVerifier)).toBe(true)
  })

  it('returns false when the derived verifier differs from the server verifier', async () => {
    // #given two phrases producing different verifiers under the same salt
    const salt = makeSaltBytesAndB64()
    const a = await generateRecoveryPhrase()
    const b = await generateRecoveryPhrase()
    const recoveredA = await recoverMasterKeyFromPhrase(a.phrase, salt.b64)
    const recoveredB = await recoverMasterKeyFromPhrase(b.phrase, salt.b64)

    // #then the verifiers don't match
    expect(validateKeyVerifier(recoveredA.keyVerifier, recoveredB.keyVerifier)).toBe(false)
  })

  it('returns false when the two verifiers have different lengths', () => {
    // #given verifiers of differing lengths
    // #then comparison short-circuits to false (length leak is acceptable for fixed-size keys)
    expect(validateKeyVerifier('short', 'considerably-longer-string')).toBe(false)
  })

  it('returns false when verifiers differ by a single byte at the same length', () => {
    // #given two equal-length verifiers differing in one character
    const a = 'aaaaaaaa'
    const b = 'aaaaaaab'

    // #then comparison rejects
    expect(validateKeyVerifier(a, b)).toBe(false)
  })
})
