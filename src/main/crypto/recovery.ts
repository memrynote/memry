/**
 * BIP39 Recovery Phrase Management
 *
 * Implements generation and validation of 24-word recovery phrases
 * using the BIP39 standard. The recovery phrase is the root of all
 * cryptographic keys in the E2EE system.
 *
 * @module main/crypto/recovery
 */

import * as bip39 from 'bip39'
import {
  type RecoveryPhraseValidation,
  DEFAULT_RECOVERY_PHRASE_CONFIG
} from '@shared/contracts/crypto'

// =============================================================================
// Recovery Phrase Generation
// =============================================================================

/**
 * Generate a new 24-word BIP39 recovery phrase.
 *
 * Uses 256 bits of entropy for maximum security (24 words).
 * The phrase includes a checksum for error detection.
 *
 * @returns 24-word recovery phrase
 */
export function generateRecoveryPhrase(): string {
  // 256 bits of entropy = 24 words
  const strength = DEFAULT_RECOVERY_PHRASE_CONFIG.wordCount === 24 ? 256 : 128
  return bip39.generateMnemonic(strength)
}

/**
 * Generate recovery phrase with specific word count.
 *
 * @param wordCount - Number of words (12, 15, 18, 21, or 24)
 * @returns Recovery phrase with specified word count
 */
export function generateRecoveryPhraseWithWordCount(wordCount: 12 | 15 | 18 | 21 | 24): string {
  // Word count to entropy bits mapping
  const entropyBits: Record<number, number> = {
    12: 128,
    15: 160,
    18: 192,
    21: 224,
    24: 256
  }

  return bip39.generateMnemonic(entropyBits[wordCount])
}

// =============================================================================
// Recovery Phrase Validation
// =============================================================================

/**
 * Validate a BIP39 recovery phrase.
 *
 * Checks:
 * 1. Word count is valid (12, 15, 18, 21, or 24)
 * 2. All words are in the BIP39 English wordlist
 * 3. Checksum is valid
 *
 * @param phrase - Recovery phrase to validate
 * @returns Validation result with details
 */
export function validateRecoveryPhrase(phrase: string): RecoveryPhraseValidation {
  // Normalize the phrase (lowercase, single spaces)
  const normalizedPhrase = normalizePhrase(phrase)

  // Check if phrase is empty
  if (!normalizedPhrase) {
    return {
      valid: false,
      error: 'Recovery phrase is empty'
    }
  }

  // Get word count
  const words = normalizedPhrase.split(' ')
  const wordCount = words.length

  // Check word count
  const validWordCounts = [12, 15, 18, 21, 24]
  if (!validWordCounts.includes(wordCount)) {
    return {
      valid: false,
      error: `Invalid word count: ${wordCount}. Must be 12, 15, 18, 21, or 24 words.`,
      wordCount
    }
  }

  // Get the BIP39 wordlist
  const wordlist = bip39.wordlists.english

  // Check each word is in the wordlist
  const invalidWords: string[] = []
  for (const word of words) {
    if (!wordlist.includes(word)) {
      invalidWords.push(word)
    }
  }

  if (invalidWords.length > 0) {
    return {
      valid: false,
      error: `Invalid words: ${invalidWords.join(', ')}`,
      wordCount,
      checksumValid: false
    }
  }

  // Validate the mnemonic (includes checksum validation)
  const isValid = bip39.validateMnemonic(normalizedPhrase)

  if (!isValid) {
    return {
      valid: false,
      error: 'Invalid checksum. Please check your recovery phrase.',
      wordCount,
      checksumValid: false
    }
  }

  return {
    valid: true,
    wordCount,
    checksumValid: true
  }
}

/**
 * Normalize a recovery phrase.
 *
 * - Converts to lowercase
 * - Trims whitespace
 * - Collapses multiple spaces to single spaces
 *
 * @param phrase - Recovery phrase to normalize
 * @returns Normalized phrase
 */
export function normalizePhrase(phrase: string): string {
  return phrase.toLowerCase().trim().replace(/\s+/g, ' ')
}

// =============================================================================
// Seed Derivation
// =============================================================================

/**
 * Derive a 64-byte seed from a recovery phrase.
 *
 * Uses PBKDF2 with the standard BIP39 passphrase 'mnemonic'.
 * The seed is then used with Argon2id to derive the master key.
 *
 * @param phrase - Recovery phrase
 * @param passphrase - Optional additional passphrase (default: empty)
 * @returns 64-byte seed
 */
export async function mnemonicToSeed(phrase: string, passphrase: string = ''): Promise<Buffer> {
  const normalizedPhrase = normalizePhrase(phrase)

  // Validate the phrase first
  const validation = validateRecoveryPhrase(normalizedPhrase)
  if (!validation.valid) {
    throw new Error(`Invalid recovery phrase: ${validation.error}`)
  }

  // Derive seed using BIP39 PBKDF2
  const seed = await bip39.mnemonicToSeed(normalizedPhrase, passphrase)
  return Buffer.from(seed)
}

/**
 * Synchronous version of mnemonicToSeed.
 *
 * @param phrase - Recovery phrase
 * @param passphrase - Optional additional passphrase (default: empty)
 * @returns 64-byte seed
 */
export function mnemonicToSeedSync(phrase: string, passphrase: string = ''): Buffer {
  const normalizedPhrase = normalizePhrase(phrase)

  // Validate the phrase first
  const validation = validateRecoveryPhrase(normalizedPhrase)
  if (!validation.valid) {
    throw new Error(`Invalid recovery phrase: ${validation.error}`)
  }

  // Derive seed using BIP39 PBKDF2
  const seed = bip39.mnemonicToSeedSync(normalizedPhrase, passphrase)
  return Buffer.from(seed)
}

// =============================================================================
// Confirmation Helpers
// =============================================================================

/**
 * Get random word indices for recovery phrase confirmation.
 *
 * Returns indices of words that the user should verify to confirm
 * they have written down their recovery phrase correctly.
 *
 * @param wordCount - Total word count in the phrase
 * @param count - Number of words to verify (default: 3)
 * @returns Array of word indices (0-based)
 */
export function getConfirmationIndices(wordCount: number, count: number = 3): number[] {
  if (count > wordCount) {
    throw new Error(`Cannot select ${count} indices from ${wordCount} words`)
  }

  const indices: number[] = []
  const available = Array.from({ length: wordCount }, (_, i) => i)

  for (let i = 0; i < count; i++) {
    const randomIndex = Math.floor(Math.random() * available.length)
    indices.push(available[randomIndex])
    available.splice(randomIndex, 1)
  }

  return indices.sort((a, b) => a - b)
}

/**
 * Verify confirmation words match the recovery phrase.
 *
 * @param phrase - Original recovery phrase
 * @param confirmations - Array of { index, word } to verify
 * @returns true if all confirmations match
 */
export function verifyConfirmationWords(
  phrase: string,
  confirmations: Array<{ index: number; word: string }>
): boolean {
  const words = normalizePhrase(phrase).split(' ')

  for (const { index, word } of confirmations) {
    if (index < 0 || index >= words.length) {
      return false
    }

    if (words[index] !== word.toLowerCase().trim()) {
      return false
    }
  }

  return true
}

/**
 * Get a word from the recovery phrase by index.
 *
 * @param phrase - Recovery phrase
 * @param index - Word index (0-based)
 * @returns Word at the specified index
 */
export function getWordAtIndex(phrase: string, index: number): string {
  const words = normalizePhrase(phrase).split(' ')

  if (index < 0 || index >= words.length) {
    throw new Error(`Invalid index: ${index}. Phrase has ${words.length} words.`)
  }

  return words[index]
}

// =============================================================================
// Wordlist Access
// =============================================================================

/**
 * Get the BIP39 English wordlist.
 *
 * @returns Array of 2048 BIP39 words
 */
export function getWordlist(): string[] {
  return bip39.wordlists.english
}

/**
 * Check if a word is in the BIP39 wordlist.
 *
 * @param word - Word to check
 * @returns true if the word is valid
 */
export function isValidWord(word: string): boolean {
  return bip39.wordlists.english.includes(word.toLowerCase().trim())
}

/**
 * Get suggestions for a partial word.
 *
 * @param partial - Partial word to match
 * @param limit - Maximum number of suggestions (default: 5)
 * @returns Array of matching words
 */
export function getWordSuggestions(partial: string, limit: number = 5): string[] {
  const normalizedPartial = partial.toLowerCase().trim()

  if (!normalizedPartial) {
    return []
  }

  const wordlist = bip39.wordlists.english
  const matches = wordlist.filter((word) => word.startsWith(normalizedPartial))

  return matches.slice(0, limit)
}
