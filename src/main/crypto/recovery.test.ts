/**
 * Recovery Phrase Tests
 *
 * Tests BIP39 recovery phrase generation, validation, and seed derivation.
 *
 * @module main/crypto/recovery.test
 */

import { describe, it, expect, vi } from 'vitest'
import {
  generateRecoveryPhrase,
  generateRecoveryPhraseWithWordCount,
  validateRecoveryPhrase,
  normalizePhrase,
  mnemonicToSeed,
  mnemonicToSeedSync,
  getConfirmationIndices,
  verifyConfirmationWords,
  getWordAtIndex,
  getWordlist,
  isValidWord,
  getWordSuggestions
} from './recovery'
import {
  TEST_RECOVERY_PHRASE_12,
  TEST_RECOVERY_PHRASE_24,
  INVALID_CHECKSUM_PHRASE,
  INVALID_WORD_PHRASE
} from './__fixtures__'
import { expectBufferEqual, expectToThrowAsync, expectToThrow } from './__helpers__'

describe('recovery', () => {
  describe('generateRecoveryPhrase', () => {
    it('should generate 24-word phrase by default', () => {
      const phrase = generateRecoveryPhrase()
      const words = phrase.split(' ')

      expect(words.length).toBe(24)
    })

    it('should generate unique phrases each call', () => {
      const phrases: string[] = []

      for (let i = 0; i < 5; i++) {
        phrases.push(generateRecoveryPhrase())
      }

      // All phrases should be different
      const unique = new Set(phrases)
      expect(unique.size).toBe(phrases.length)
    })

    it('should only use BIP39 wordlist words', () => {
      const phrase = generateRecoveryPhrase()
      const words = phrase.split(' ')
      const wordlist = getWordlist()

      for (const word of words) {
        expect(wordlist).toContain(word)
      }
    })

    it('should generate valid phrases (checksum passes)', () => {
      for (let i = 0; i < 5; i++) {
        const phrase = generateRecoveryPhrase()
        const validation = validateRecoveryPhrase(phrase)

        expect(validation.valid).toBe(true)
        expect(validation.checksumValid).toBe(true)
      }
    })
  })

  describe('generateRecoveryPhraseWithWordCount', () => {
    it('should generate 12-word phrase', () => {
      const phrase = generateRecoveryPhraseWithWordCount(12)
      const words = phrase.split(' ')

      expect(words.length).toBe(12)
    })

    it('should generate 15-word phrase', () => {
      const phrase = generateRecoveryPhraseWithWordCount(15)
      const words = phrase.split(' ')

      expect(words.length).toBe(15)
    })

    it('should generate 18-word phrase', () => {
      const phrase = generateRecoveryPhraseWithWordCount(18)
      const words = phrase.split(' ')

      expect(words.length).toBe(18)
    })

    it('should generate 21-word phrase', () => {
      const phrase = generateRecoveryPhraseWithWordCount(21)
      const words = phrase.split(' ')

      expect(words.length).toBe(21)
    })

    it('should generate 24-word phrase', () => {
      const phrase = generateRecoveryPhraseWithWordCount(24)
      const words = phrase.split(' ')

      expect(words.length).toBe(24)
    })

    it('should generate valid phrases for all word counts', () => {
      const wordCounts: (12 | 15 | 18 | 21 | 24)[] = [12, 15, 18, 21, 24]

      for (const count of wordCounts) {
        const phrase = generateRecoveryPhraseWithWordCount(count)
        const validation = validateRecoveryPhrase(phrase)

        expect(validation.valid).toBe(true)
        expect(validation.wordCount).toBe(count)
      }
    })
  })

  describe('validateRecoveryPhrase', () => {
    it('should validate correct 24-word phrase', () => {
      const result = validateRecoveryPhrase(TEST_RECOVERY_PHRASE_24)

      expect(result.valid).toBe(true)
      expect(result.wordCount).toBe(24)
      expect(result.checksumValid).toBe(true)
    })

    it('should validate correct 12-word phrase', () => {
      const result = validateRecoveryPhrase(TEST_RECOVERY_PHRASE_12)

      expect(result.valid).toBe(true)
      expect(result.wordCount).toBe(12)
      expect(result.checksumValid).toBe(true)
    })

    it('should reject empty phrase', () => {
      const result = validateRecoveryPhrase('')

      expect(result.valid).toBe(false)
      expect(result.error).toContain('empty')
    })

    it('should reject wrong word count (e.g., 23 words)', () => {
      const phrase = 'abandon '.repeat(23).trim()
      const result = validateRecoveryPhrase(phrase)

      expect(result.valid).toBe(false)
      expect(result.error).toContain('Invalid word count')
      expect(result.wordCount).toBe(23)
    })

    it('should reject invalid words not in BIP39 wordlist', () => {
      const result = validateRecoveryPhrase(INVALID_WORD_PHRASE)

      expect(result.valid).toBe(false)
      expect(result.error).toContain('Invalid words')
      expect(result.error).toContain('xyz')
    })

    it('should reject phrase with invalid checksum', () => {
      const result = validateRecoveryPhrase(INVALID_CHECKSUM_PHRASE)

      expect(result.valid).toBe(false)
      expect(result.error).toContain('checksum')
      expect(result.checksumValid).toBe(false)
    })

    it('should return wordCount in result', () => {
      const result = validateRecoveryPhrase(TEST_RECOVERY_PHRASE_24)

      expect(result.wordCount).toBe(24)
    })

    it('should return checksumValid in result', () => {
      const result = validateRecoveryPhrase(TEST_RECOVERY_PHRASE_24)

      expect(result.checksumValid).toBe(true)
    })

    it('should normalize whitespace', () => {
      const phraseWithExtraSpaces = TEST_RECOVERY_PHRASE_24.replace(/ /g, '  ')
      const result = validateRecoveryPhrase(phraseWithExtraSpaces)

      expect(result.valid).toBe(true)
    })

    it('should be case-insensitive', () => {
      const upperPhrase = TEST_RECOVERY_PHRASE_24.toUpperCase()
      const result = validateRecoveryPhrase(upperPhrase)

      expect(result.valid).toBe(true)
    })

    it('should handle mixed case', () => {
      const words = TEST_RECOVERY_PHRASE_24.split(' ')
      const mixedPhrase = words.map((w, i) => (i % 2 === 0 ? w.toUpperCase() : w)).join(' ')
      const result = validateRecoveryPhrase(mixedPhrase)

      expect(result.valid).toBe(true)
    })

    it('should handle leading/trailing whitespace', () => {
      const phraseWithWhitespace = `  ${TEST_RECOVERY_PHRASE_24}  `
      const result = validateRecoveryPhrase(phraseWithWhitespace)

      expect(result.valid).toBe(true)
    })
  })

  describe('normalizePhrase', () => {
    it('should convert to lowercase', () => {
      const normalized = normalizePhrase('ABANDON ABOUT')

      expect(normalized).toBe('abandon about')
    })

    it('should trim whitespace', () => {
      const normalized = normalizePhrase('  abandon about  ')

      expect(normalized).toBe('abandon about')
    })

    it('should collapse multiple spaces to single space', () => {
      const normalized = normalizePhrase('abandon   about')

      expect(normalized).toBe('abandon about')
    })

    it('should handle tabs and newlines', () => {
      const normalized = normalizePhrase('abandon\t\nabout')

      expect(normalized).toBe('abandon about')
    })

    it('should handle empty string', () => {
      const normalized = normalizePhrase('')

      expect(normalized).toBe('')
    })

    it('should handle whitespace-only string', () => {
      const normalized = normalizePhrase('   ')

      expect(normalized).toBe('')
    })
  })

  describe('mnemonicToSeed', () => {
    it('should derive 64-byte seed from phrase', async () => {
      const seed = await mnemonicToSeed(TEST_RECOVERY_PHRASE_24)

      expect(seed).toBeInstanceOf(Buffer)
      expect(seed.length).toBe(64)
    })

    it('should be deterministic', async () => {
      const seed1 = await mnemonicToSeed(TEST_RECOVERY_PHRASE_24)
      const seed2 = await mnemonicToSeed(TEST_RECOVERY_PHRASE_24)

      expectBufferEqual(seed1, seed2)
    })

    it('should support optional passphrase', async () => {
      const seedWithoutPassphrase = await mnemonicToSeed(TEST_RECOVERY_PHRASE_24)
      const seedWithPassphrase = await mnemonicToSeed(TEST_RECOVERY_PHRASE_24, 'my-passphrase')

      expect(seedWithPassphrase.length).toBe(64)
      expect(seedWithoutPassphrase.equals(seedWithPassphrase)).toBe(false)
    })

    it('should produce different seed with passphrase', async () => {
      const seed1 = await mnemonicToSeed(TEST_RECOVERY_PHRASE_24, 'passphrase1')
      const seed2 = await mnemonicToSeed(TEST_RECOVERY_PHRASE_24, 'passphrase2')

      expect(seed1.equals(seed2)).toBe(false)
    })

    it('should throw for invalid phrase', async () => {
      await expectToThrowAsync(
        () => mnemonicToSeed(INVALID_CHECKSUM_PHRASE),
        'Invalid recovery phrase'
      )
    })

    it('should normalize phrase before deriving seed', async () => {
      const seed1 = await mnemonicToSeed(TEST_RECOVERY_PHRASE_24)
      const seed2 = await mnemonicToSeed(TEST_RECOVERY_PHRASE_24.toUpperCase())

      expectBufferEqual(seed1, seed2)
    })
  })

  describe('mnemonicToSeedSync', () => {
    it('should derive 64-byte seed from phrase', () => {
      const seed = mnemonicToSeedSync(TEST_RECOVERY_PHRASE_24)

      expect(seed).toBeInstanceOf(Buffer)
      expect(seed.length).toBe(64)
    })

    it('should be deterministic', () => {
      const seed1 = mnemonicToSeedSync(TEST_RECOVERY_PHRASE_24)
      const seed2 = mnemonicToSeedSync(TEST_RECOVERY_PHRASE_24)

      expectBufferEqual(seed1, seed2)
    })

    it('should support optional passphrase', () => {
      const seedWithoutPassphrase = mnemonicToSeedSync(TEST_RECOVERY_PHRASE_24)
      const seedWithPassphrase = mnemonicToSeedSync(TEST_RECOVERY_PHRASE_24, 'my-passphrase')

      expect(seedWithPassphrase.length).toBe(64)
      expect(seedWithoutPassphrase.equals(seedWithPassphrase)).toBe(false)
    })

    it('should throw for invalid phrase', () => {
      expectToThrow(() => mnemonicToSeedSync(INVALID_CHECKSUM_PHRASE), 'Invalid recovery phrase')
    })

    it('should produce same result as async version', async () => {
      const seedSync = mnemonicToSeedSync(TEST_RECOVERY_PHRASE_24)
      const seedAsync = await mnemonicToSeed(TEST_RECOVERY_PHRASE_24)

      expectBufferEqual(seedSync, seedAsync)
    })
  })

  describe('getConfirmationIndices', () => {
    it('should return specified number of random indices', () => {
      const indices = getConfirmationIndices(24, 3)

      expect(indices.length).toBe(3)
    })

    it('should return sorted indices', () => {
      for (let i = 0; i < 10; i++) {
        const indices = getConfirmationIndices(24, 5)

        const sorted = [...indices].sort((a, b) => a - b)
        expect(indices).toEqual(sorted)
      }
    })

    it('should not return duplicate indices', () => {
      for (let i = 0; i < 10; i++) {
        const indices = getConfirmationIndices(24, 10)

        const unique = new Set(indices)
        expect(unique.size).toBe(indices.length)
      }
    })

    it('should stay within word count bounds', () => {
      const wordCount = 12
      for (let i = 0; i < 10; i++) {
        const indices = getConfirmationIndices(wordCount, 3)

        for (const index of indices) {
          expect(index).toBeGreaterThanOrEqual(0)
          expect(index).toBeLessThan(wordCount)
        }
      }
    })

    it('should throw if count > wordCount', () => {
      expectToThrow(() => getConfirmationIndices(3, 5), 'Cannot select 5 indices from 3 words')
    })

    it('should handle count equal to wordCount', () => {
      const indices = getConfirmationIndices(5, 5)

      expect(indices.length).toBe(5)
      expect(indices).toEqual([0, 1, 2, 3, 4])
    })

    it('should return different indices on multiple calls (statistical)', () => {
      const results: number[][] = []

      for (let i = 0; i < 10; i++) {
        results.push(getConfirmationIndices(24, 3))
      }

      // At least some should be different (very high probability)
      const uniqueResults = new Set(results.map((r) => r.join(',')))
      expect(uniqueResults.size).toBeGreaterThan(1)
    })
  })

  describe('verifyConfirmationWords', () => {
    it('should return true for correct words at indices', () => {
      const phrase = TEST_RECOVERY_PHRASE_24
      const words = phrase.split(' ')

      const confirmations = [
        { index: 0, word: words[0] },
        { index: 5, word: words[5] },
        { index: 23, word: words[23] }
      ]

      const result = verifyConfirmationWords(phrase, confirmations)

      expect(result).toBe(true)
    })

    it('should return false for wrong words', () => {
      const phrase = TEST_RECOVERY_PHRASE_24

      const confirmations = [
        { index: 0, word: 'wrong' },
        { index: 5, word: 'words' }
      ]

      const result = verifyConfirmationWords(phrase, confirmations)

      expect(result).toBe(false)
    })

    it('should return false for wrong indices', () => {
      const phrase = TEST_RECOVERY_PHRASE_24
      const words = phrase.split(' ')

      // Use word from last index (art) but claim it's at index 0 (abandon)
      // These are different words so this should fail
      const confirmations = [{ index: 0, word: words[23] }]

      const result = verifyConfirmationWords(phrase, confirmations)

      expect(result).toBe(false)
    })

    it('should handle case-insensitive comparison', () => {
      const phrase = TEST_RECOVERY_PHRASE_24
      const words = phrase.split(' ')

      const confirmations = [{ index: 0, word: words[0].toUpperCase() }]

      const result = verifyConfirmationWords(phrase, confirmations)

      expect(result).toBe(true)
    })

    it('should handle whitespace in input', () => {
      const phrase = TEST_RECOVERY_PHRASE_24
      const words = phrase.split(' ')

      const confirmations = [{ index: 0, word: `  ${words[0]}  ` }]

      const result = verifyConfirmationWords(phrase, confirmations)

      expect(result).toBe(true)
    })

    it('should return false for out of bounds index', () => {
      const phrase = TEST_RECOVERY_PHRASE_24

      const confirmations = [{ index: 100, word: 'abandon' }]

      const result = verifyConfirmationWords(phrase, confirmations)

      expect(result).toBe(false)
    })

    it('should return false for negative index', () => {
      const phrase = TEST_RECOVERY_PHRASE_24

      const confirmations = [{ index: -1, word: 'abandon' }]

      const result = verifyConfirmationWords(phrase, confirmations)

      expect(result).toBe(false)
    })

    it('should return true for empty confirmations array', () => {
      const phrase = TEST_RECOVERY_PHRASE_24

      const result = verifyConfirmationWords(phrase, [])

      expect(result).toBe(true)
    })
  })

  describe('getWordAtIndex', () => {
    it('should return correct word at index', () => {
      const phrase = TEST_RECOVERY_PHRASE_24
      const words = phrase.split(' ')

      for (let i = 0; i < words.length; i++) {
        const word = getWordAtIndex(phrase, i)
        expect(word).toBe(words[i])
      }
    })

    it('should handle first word (index 0)', () => {
      const word = getWordAtIndex(TEST_RECOVERY_PHRASE_24, 0)

      expect(word).toBe('abandon')
    })

    it('should handle last word (index 23)', () => {
      const word = getWordAtIndex(TEST_RECOVERY_PHRASE_24, 23)

      expect(word).toBe('art')
    })

    it('should throw for out of bounds (positive)', () => {
      expectToThrow(() => getWordAtIndex(TEST_RECOVERY_PHRASE_24, 24), 'Invalid index')
    })

    it('should throw for out of bounds (negative)', () => {
      expectToThrow(() => getWordAtIndex(TEST_RECOVERY_PHRASE_24, -1), 'Invalid index')
    })
  })

  describe('getWordlist', () => {
    it('should return 2048 words', () => {
      const wordlist = getWordlist()

      expect(wordlist.length).toBe(2048)
    })

    it('should include common words like "abandon"', () => {
      const wordlist = getWordlist()

      expect(wordlist).toContain('abandon')
      expect(wordlist).toContain('about')
      expect(wordlist).toContain('zoo')
    })

    it('should be sorted alphabetically', () => {
      const wordlist = getWordlist()

      // Check first word is 'abandon' and last is 'zoo'
      expect(wordlist[0]).toBe('abandon')
      expect(wordlist[wordlist.length - 1]).toBe('zoo')
    })

    it('should contain unique words only', () => {
      const wordlist = getWordlist()
      const unique = new Set(wordlist)

      expect(unique.size).toBe(wordlist.length)
    })
  })

  describe('isValidWord', () => {
    it('should return true for valid BIP39 words', () => {
      expect(isValidWord('abandon')).toBe(true)
      expect(isValidWord('zoo')).toBe(true)
      expect(isValidWord('middle')).toBe(true)
    })

    it('should return false for invalid words', () => {
      expect(isValidWord('xyz')).toBe(false)
      expect(isValidWord('test123')).toBe(false)
      expect(isValidWord('notaword')).toBe(false)
    })

    it('should be case-insensitive', () => {
      expect(isValidWord('ABANDON')).toBe(true)
      expect(isValidWord('Abandon')).toBe(true)
      expect(isValidWord('aBaNdOn')).toBe(true)
    })

    it('should handle whitespace', () => {
      expect(isValidWord('  abandon  ')).toBe(true)
    })

    it('should return false for empty string', () => {
      expect(isValidWord('')).toBe(false)
    })
  })

  describe('getWordSuggestions', () => {
    it('should return words starting with prefix', () => {
      const suggestions = getWordSuggestions('ab')

      expect(suggestions.length).toBeGreaterThan(0)
      for (const word of suggestions) {
        expect(word.startsWith('ab')).toBe(true)
      }
    })

    it('should limit results', () => {
      const suggestions = getWordSuggestions('a', 3)

      expect(suggestions.length).toBeLessThanOrEqual(3)
    })

    it('should return empty for non-matching prefix', () => {
      const suggestions = getWordSuggestions('xyz')

      expect(suggestions.length).toBe(0)
    })

    it('should handle empty prefix', () => {
      const suggestions = getWordSuggestions('')

      expect(suggestions.length).toBe(0)
    })

    it('should be case-insensitive', () => {
      const suggestionsLower = getWordSuggestions('ab')
      const suggestionsUpper = getWordSuggestions('AB')

      expect(suggestionsLower).toEqual(suggestionsUpper)
    })

    it('should use default limit of 5', () => {
      const suggestions = getWordSuggestions('a')

      expect(suggestions.length).toBeLessThanOrEqual(5)
    })

    it('should return exact match first', () => {
      const suggestions = getWordSuggestions('abandon')

      expect(suggestions[0]).toBe('abandon')
    })
  })
})
