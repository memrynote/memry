import type { SyncPushCryptoProvider } from '@memry/sync-client/push'
import {
  decrypt,
  encrypt,
  fromBase64,
  generateFileKey,
  signDetached,
  toBase64,
  unwrapFileKey,
  verifyDetached,
  wrapFileKey
} from '../crypto/libsodium'

/**
 * The write path's crypto seam over the JSI libsodium module (US2).
 *
 * Superset of the pull provider — same module, same vector-parity guarantee
 * (G0-a) — so an item this device encrypts decrypts byte-identically on
 * desktop and vice versa.
 */
export function createMobilePushCryptoProvider(): SyncPushCryptoProvider {
  return {
    generateFileKey,
    encrypt: (plaintext, key, associatedData) => encrypt(plaintext, key, associatedData),
    wrapFileKey: (fileKey, vaultKey) => wrapFileKey(fileKey, vaultKey),
    signDetached: (message, secretKey) => signDetached(message, secretKey),
    unwrapFileKey: (wrappedKey, nonce, vaultKey) => unwrapFileKey(wrappedKey, nonce, vaultKey),
    decrypt: (ciphertext, nonce, key, associatedData) =>
      decrypt(ciphertext, nonce, key, associatedData),
    verifyDetached: (signature, message, publicKey) =>
      verifyDetached(signature, message, publicKey),
    fromBase64,
    toBase64
  }
}
