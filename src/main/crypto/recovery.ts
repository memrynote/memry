import * as bip39 from 'bip39'

import type { RecoveryPhraseResult } from '@shared/contracts/crypto'

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
  const seed = new Uint8Array(seedBuffer.length)
  seed.set(new Uint8Array(seedBuffer.buffer, seedBuffer.byteOffset, seedBuffer.byteLength))
  const original = new Uint8Array(seedBuffer.buffer, seedBuffer.byteOffset, seedBuffer.byteLength)
  original.fill(0)
  return seed
}
