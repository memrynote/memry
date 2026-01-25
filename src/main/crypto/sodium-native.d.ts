/**
 * Type augmentation for sodium-native X25519 key exchange functions.
 * These functions exist at runtime but are missing from the type definitions.
 */

declare module 'sodium-native' {
  // X25519 Key Exchange Constants
  export const crypto_kx_PUBLICKEYBYTES: number
  export const crypto_kx_SECRETKEYBYTES: number
  export const crypto_scalarmult_BYTES: number

  /**
   * Generate X25519 keypair for key exchange.
   */
  export function crypto_kx_keypair(publicKey: Buffer, secretKey: Buffer): void

  /**
   * Perform X25519 scalar multiplication (ECDH).
   * Computes sharedSecret = secretKey * publicKey
   */
  export function crypto_scalarmult(
    sharedSecret: Buffer,
    secretKey: Buffer,
    publicKey: Buffer
  ): void

  /**
   * Securely zero memory.
   */
  export function sodium_memzero(buffer: Buffer): void
}
