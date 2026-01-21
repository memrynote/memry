/**
 * BIP39 Recovery Phrase Management
 *
 * Implements 24-word mnemonic generation and validation
 * for master key derivation.
 */

import * as bip39 from 'bip39'
import { CryptoError, CryptoErrorCode } from './errors'

/**
 * Generate a new 24-word BIP39 recovery phrase.
 * Uses 256 bits of entropy for maximum security.
 *
 * @returns Array of 24 words
 */
export function generateRecoveryPhrase(): string[] {
  // 256 bits of entropy = 24 words
  const mnemonic = bip39.generateMnemonic(256)
  return mnemonic.split(' ')
}

/**
 * Validate a BIP39 recovery phrase.
 *
 * @param phrase - Array of words or space-separated string
 * @returns true if valid, false otherwise
 */
export function validateRecoveryPhrase(phrase: string[] | string): boolean {
  const mnemonic = Array.isArray(phrase) ? phrase.join(' ') : phrase
  return bip39.validateMnemonic(mnemonic)
}

/**
 * Convert a recovery phrase to entropy bytes.
 * This entropy is used as input for master key derivation.
 *
 * @param phrase - Array of 24 words or space-separated string
 * @returns 32 bytes of entropy
 * @throws CryptoError if phrase is invalid
 */
export function phraseToEntropy(phrase: string[] | string): Uint8Array {
  const mnemonic = Array.isArray(phrase) ? phrase.join(' ') : phrase

  if (!bip39.validateMnemonic(mnemonic)) {
    throw new CryptoError('Invalid recovery phrase', CryptoErrorCode.INVALID_RECOVERY_PHRASE)
  }

  const entropyHex = bip39.mnemonicToEntropy(mnemonic)
  return hexToBytes(entropyHex)
}

/**
 * Convert entropy bytes to a recovery phrase.
 * Useful for testing or recovery scenarios.
 *
 * @param entropy - 32 bytes of entropy
 * @returns Array of 24 words
 * @throws CryptoError if entropy is invalid
 */
export function entropyToPhrase(entropy: Uint8Array): string[] {
  if (entropy.length !== 32) {
    throw new CryptoError(
      `Invalid entropy length: expected 32 bytes, got ${entropy.length}`,
      CryptoErrorCode.INVALID_RECOVERY_PHRASE
    )
  }

  try {
    const entropyHex = bytesToHex(entropy)
    const mnemonic = bip39.entropyToMnemonic(entropyHex)
    return mnemonic.split(' ')
  } catch (error) {
    throw new CryptoError(
      'Failed to convert entropy to phrase',
      CryptoErrorCode.INVALID_RECOVERY_PHRASE,
      error
    )
  }
}

/**
 * Convert hex string to Uint8Array
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

/**
 * Convert Uint8Array to hex string
 */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
