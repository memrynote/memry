/**
 * The crypto surface the pull engine needs, injected by the shell.
 *
 * `@memry/sync-client` deliberately contains no crypto: desktop backs this
 * with libsodium-wrappers-sumo, mobile with the JSI react-native-libsodium
 * module (`apps/mobile/src/crypto/libsodium.ts`). Byte-for-byte parity between
 * the two is proven by the crypto-vectors suite (G0-a), so the engine can be
 * indifferent to which one it received.
 *
 * `associatedData` is a STRING on this interface because the mobile binding
 * only accepts string AD (`''` means libsodium NULL); implementations encode
 * it as UTF-8, which matches desktop's byte usage exactly.
 */
export interface SyncCryptoProvider {
  unwrapFileKey(
    wrappedKey: Uint8Array,
    nonce: Uint8Array,
    vaultKey: Uint8Array
  ): Uint8Array | Promise<Uint8Array>
  decrypt(
    ciphertext: Uint8Array,
    nonce: Uint8Array,
    key: Uint8Array,
    associatedData?: string
  ): Uint8Array | Promise<Uint8Array>
  verifyDetached(
    signature: Uint8Array,
    message: Uint8Array,
    publicKey: Uint8Array
  ): boolean | Promise<boolean>
  /** base64 variant ORIGINAL on both shells. */
  fromBase64(value: string): Uint8Array
  toBase64(bytes: Uint8Array): string
}
