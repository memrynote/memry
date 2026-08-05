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

export interface UploadedChunkEntry {
  i: number
  h: string
  b?: number
}

export type UploadedChunksRead =
  | { ok: true; entries: UploadedChunkEntry[] }
  | { ok: false; entries: []; reason: 'malformed-json' | 'not-an-array' }

/**
 * Read an upload session's persisted `uploaded_chunks` JSON, reporting whether
 * the column actually decoded to a chunk array.
 *
 * `uploaded_chunks` is only ever written server-side (`JSON.stringify` at
 * initiate, `json_insert` per chunk), so `ok: false` means DB corruption or a
 * partial write — never a hostile client. That distinction matters because the
 * two families of caller must react in opposite directions:
 *
 *   - Paths that ACQUIRE storage or bill the user (chunk PUT, complete) must
 *     fail closed. Degrading a corrupt column to "no chunks" reports zero
 *     landed bytes, which resets the quota ceiling in routes/blob.ts and
 *     re-opens the duplicate-chunk guard.
 *   - Paths that RELEASE storage (session abort, vault deletion) must never be
 *     blocked by a corrupt column, or the user's reservation is stranded and
 *     their vault cannot be deleted. Those use `parseUploadedChunks` and
 *     release the full reservation.
 *
 * Either way the corruption is logged by the caller rather than swallowed.
 */
export function readUploadedChunks(value: string): UploadedChunksRead {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return { ok: false, entries: [], reason: 'malformed-json' }
  }
  if (!Array.isArray(parsed)) return { ok: false, entries: [], reason: 'not-an-array' }
  return { ok: true, entries: parsed as UploadedChunkEntry[] }
}

/**
 * Parse an upload session's persisted `uploaded_chunks` JSON into typed
 * entries, tolerating a malformed or non-array payload as "no chunks".
 *
 * Total by design — it never throws — so a corrupt column cannot abort a
 * storage-releasing path. Callers that must not silently treat corruption as an
 * empty upload should use `readUploadedChunks` instead.
 */
export function parseUploadedChunks(value: string): UploadedChunkEntry[] {
  return readUploadedChunks(value).entries
}

/**
 * Sum the per-chunk byte counts of an upload session, or null if any entry
 * lacks a valid non-negative integer count — the caller then falls back to the
 * reserved total rather than under-counting.
 */
export function getUploadedByteTotal(entries: UploadedChunkEntry[]): number | null {
  let total = 0
  for (const entry of entries) {
    const bytes = entry.b
    if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 0) return null
    total += bytes
  }
  return total
}
