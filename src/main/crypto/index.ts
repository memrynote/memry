import sodium from 'libsodium-wrappers-sumo'

export {
  deriveKey,
  deriveMasterKey,
  generateDeviceSigningKeyPair,
  generateFileKey,
  generateKeyVerifier,
  generateSalt,
  getDevicePublicKey,
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

export const constantTimeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) {
    throw new Error('constantTimeEqual: inputs must have equal length')
  }
  return sodium.memcmp(a, b)
}

export const initCrypto = async (): Promise<void> => {
  await sodium.ready
}
