import type { SyncCryptoProvider } from '@memry/sync-client/pull'
import { decrypt, fromBase64, toBase64, unwrapFileKey, verifyDetached } from '../crypto/libsodium'

/**
 * The pull engine's crypto seam over the JSI libsodium module (T012,
 * vector-parity proven against desktop). AD is passed as a string — the
 * binding's contract; UTF-8 bytes match desktop's usage exactly.
 */
export function createMobileCryptoProvider(): SyncCryptoProvider {
  return {
    unwrapFileKey: (wrappedKey, nonce, vaultKey) => unwrapFileKey(wrappedKey, nonce, vaultKey),
    decrypt: (ciphertext, nonce, key, associatedData) =>
      decrypt(ciphertext, nonce, key, associatedData),
    verifyDetached: (signature, message, publicKey) =>
      verifyDetached(signature, message, publicKey),
    fromBase64,
    toBase64
  }
}
