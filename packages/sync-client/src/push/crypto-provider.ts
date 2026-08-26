import type { SyncCryptoProvider } from '../pull/crypto-provider.ts'

/**
 * The crypto surface the PUSH path needs, on top of the pull provider.
 *
 * Same rule as the pull side: `@memry/sync-client` contains no crypto. Desktop
 * backs this with libsodium-wrappers-sumo, mobile with the JSI
 * react-native-libsodium module, and the crypto-vectors suite (G0-a) is what
 * lets the engine be indifferent to which one it received.
 *
 * `associatedData` is a STRING for the same reason it is on the pull provider —
 * the mobile binding only accepts string AD — and implementations encode it as
 * UTF-8, which is byte-identical to desktop's usage.
 */
export interface SyncPushCryptoProvider extends SyncCryptoProvider {
  generateFileKey(): Uint8Array
  encrypt(
    plaintext: Uint8Array,
    key: Uint8Array,
    associatedData?: string
  ): { ciphertext: Uint8Array; nonce: Uint8Array }
  wrapFileKey(
    fileKey: Uint8Array,
    vaultKey: Uint8Array
  ): { wrappedKey: Uint8Array; nonce: Uint8Array }
  signDetached(message: Uint8Array, secretKey: Uint8Array): Uint8Array
}
