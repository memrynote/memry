import { XCHACHA20_PARAMS } from '@memry/contracts/crypto'

// Clients upload each chunk as nonce || XChaCha20-Poly1305 ciphertext, and the
// ciphertext carries a Poly1305 tag — so every chunk is plaintext + 40 bytes on
// the wire. Derived from packages/contracts/src/crypto.ts so a crypto change
// cannot silently drift from this accounting.
export const CHUNK_CRYPTO_OVERHEAD = XCHACHA20_PARAMS.NONCE_LENGTH + XCHACHA20_PARAMS.TAG_LENGTH

// Upper bound used to sanity-check a client-declared encryptedSize. Leaves slack
// for a future AEAD with a larger nonce/tag without trusting the client's number.
export const MAX_CHUNK_CRYPTO_OVERHEAD = 64

/**
 * Bytes actually put on the wire (and stored) for an upload session: explicit
 * when the client declared it, otherwise derived from the plaintext size plus
 * per-chunk crypto overhead.
 *
 * Storage quota is reserved and refunded against this value. Plan file-size
 * limits stay on the plaintext size, so encryption overhead never eats into a
 * user's limit.
 *
 * The derive path (`encryptedSize === null`) is what makes already-installed
 * clients — and sessions opened before `encrypted_size` existed — work.
 */
export function expectedEncryptedTotal(
  totalSize: number,
  chunkCount: number,
  encryptedSize: number | null
): number {
  return encryptedSize ?? totalSize + CHUNK_CRYPTO_OVERHEAD * chunkCount
}
