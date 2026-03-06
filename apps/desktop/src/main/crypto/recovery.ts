import * as bip39 from 'bip39'
import sodium from 'libsodium-wrappers-sumo'

import type { RecoveryPhraseResult } from '@memry/contracts/crypto'

import { deriveMasterKey } from './keys'

// Callers MUST call secureCleanup(result.seed) after using the seed for key derivation.
// The seed contains sensitive key material that should not persist in memory.
export const generateRecoveryPhrase = async (): Promise<RecoveryPhraseResult> => {
  const phrase = bip39.generateMnemonic(256)
  const seedBuffer = await bip39.mnemonicToSeed(phrase)
  const seed = new Uint8Array(seedBuffer.buffer, seedBuffer.byteOffset, seedBuffer.byteLength)

  return { phrase, seed }
}

export const validateRecoveryPhrase = (phrase: string): boolean => {
  return bip39.validateMnemonic(phrase)
}

export const phraseToSeed = async (phrase: string): Promise<Uint8Array> => {
  const seedBuffer = await bip39.mnemonicToSeed(phrase)
  return new Uint8Array(seedBuffer.buffer, seedBuffer.byteOffset, seedBuffer.byteLength)
}

export interface RecoveredKeyMaterial {
  masterKey: Uint8Array
  keyVerifier: string
  kdfSalt: string
}

export const recoverMasterKeyFromPhrase = async (
  phrase: string,
  kdfSalt: string
): Promise<RecoveredKeyMaterial> => {
  const seed = await phraseToSeed(phrase)
  const saltBytes = sodium.from_base64(kdfSalt, sodium.base64_variants.ORIGINAL)

  try {
    return await deriveMasterKey(seed, saltBytes)
  } finally {
    sodium.memzero(seed)
    sodium.memzero(saltBytes)
  }
}

export const validateKeyVerifier = (derivedVerifier: string, serverVerifier: string): boolean => {
  const derivedBytes = new TextEncoder().encode(derivedVerifier)
  const serverBytes = new TextEncoder().encode(serverVerifier)
  if (derivedBytes.length !== serverBytes.length) {
    return false
  }
  return sodium.memcmp(derivedBytes, serverBytes)
}
