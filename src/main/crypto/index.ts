import sodium from 'libsodium-wrappers-sumo'

export {
  deriveKey,
  deriveMasterKey,
  generateDeviceSigningKeyPair,
  generateFileKey,
  generateKeyVerifier,
  generateSalt,
  getDevicePublicKey,
  getOrCreateSigningKeyPair,
  getOrDeriveVaultKey
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

/**
 * Constant-time comparison via libsodium memcmp.
 * Callers MUST ensure a.length === b.length for timing-safety;
 * the early-return on mismatched lengths leaks only the fact that
 * lengths differ, which is acceptable for fixed-size keys/MACs.
 */
export const constantTimeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) {
    return false
  }
  return sodium.memcmp(a, b)
}

export const initCrypto = async (): Promise<void> => {
  await sodium.ready
}
