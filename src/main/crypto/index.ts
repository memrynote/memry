import sodium from 'libsodium-wrappers-sumo'

export {
  deriveKey,
  deriveMasterKey,
  generateDeviceSigningKeyPair,
  generateFileKey,
  generateKeyVerifier,
  generateSalt,
  getDevicePublicKey
} from './keys'

export { generateRecoveryPhrase, phraseToSeed, validateRecoveryPhrase } from './recovery'

export { decrypt, encrypt, generateNonce, unwrapFileKey, wrapFileKey } from './encryption'

export { signPayload, verifySignature } from './signatures'

export { encodeCbor } from './cbor'
export { CBOR_FIELD_ORDER } from '@shared/contracts/cbor-ordering'

export { deleteKey, retrieveKey, storeKey } from './keychain'

export const secureCleanup = (...buffers: Uint8Array[]): void => {
  for (const buffer of buffers) {
    sodium.memzero(buffer)
  }
}

export const constantTimeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  const lengthsMatch = a.length === b.length
  const maxLen = Math.max(a.length, b.length)
  const paddedA = new Uint8Array(maxLen)
  const paddedB = new Uint8Array(maxLen)
  paddedA.set(a)
  paddedB.set(b)

  const contentsMatch = sodium.memcmp(paddedA, paddedB)
  return lengthsMatch && contentsMatch
}

export const initCrypto = async (): Promise<void> => {
  await sodium.ready
}
