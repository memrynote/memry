import sodium from 'libsodium-wrappers-sumo'

export {
  computeKeyConfirm,
  computeLinkingProof,
  computeProviderAuthConfirm,
  computeSharedSecret,
  computeVerificationCode,
  deriveKey,
  deriveLinkingKeys,
  deriveMasterKey,
  generateDeviceSigningKeyPair,
  generateFileKey,
  generateKeyVerifier,
  generateSalt,
  generateX25519KeyPair,
  getDevicePublicKey,
  getOrCreateSigningKeyPair,
  getOrDeriveVaultKey
} from './keys'

export {
  generateRecoveryPhrase,
  phraseToSeed,
  recoverMasterKeyFromPhrase,
  validateKeyVerifier,
  validateRecoveryPhrase
} from './recovery'
export type { RecoveredKeyMaterial } from './recovery'

export {
  decrypt,
  decryptMasterKeyFromLinking,
  encrypt,
  encryptMasterKeyForLinking,
  generateNonce,
  unwrapFileKey,
  wrapFileKey
} from './encryption'

export { signPayload, verifySignature } from './signatures'

export { encodeCbor } from './cbor'
export { CBOR_FIELD_ORDER } from '@memry/contracts/cbor-ordering'

export { deleteKey, retrieveKey, storeKey } from './keychain'

export { secureCleanup } from './primitives'
export { lockKeyMaterial, unlockKeyMaterial } from './memory-lock'

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
