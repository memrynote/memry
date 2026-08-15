/**
 * The per-item sync ceiling, in one place.
 *
 * `encryptItemForPush` rejects a push payload whose byte length, multiplied by
 * the base64 + crypto overhead factor, is over the 5 MiB cap. For a note that
 * cap lands on the JSON push payload, which carries the whole markdown body on
 * `create` — so the real limit a user experiences is roughly 3.7 MB of note
 * text, well below the server's 8 MiB `/sync/*` body cap. That makes this the
 * ceiling that actually fires, which is why it needs a user-visible signal
 * rather than a queue row (#1465).
 *
 * Kept free of Electron and DB imports: the sync worker thread imports it
 * through `encrypt.ts`.
 */

export const SYNC_ITEM_MAX_ENCRYPT_BYTES = 5 * 1024 * 1024

export const SYNC_ITEM_ENCRYPT_OVERHEAD = 1.37

/**
 * Largest payload that still encrypts. Derived from the cap rather than
 * restated, so the two can never drift apart.
 */
export const NOTE_SYNC_MAX_BYTES = Math.floor(
  SYNC_ITEM_MAX_ENCRYPT_BYTES / SYNC_ITEM_ENCRYPT_OVERHEAD
)

/** Fraction of the ceiling at which a note is called out while it still syncs. */
export const NOTE_SYNC_WARN_RATIO = 0.8

export const NOTE_SYNC_WARN_BYTES = Math.floor(NOTE_SYNC_MAX_BYTES * NOTE_SYNC_WARN_RATIO)

export type NoteSyncSizeStatus = 'ok' | 'approaching' | 'over'

export function classifyNoteSyncSize(bytes: number): NoteSyncSizeStatus {
  if (bytes > NOTE_SYNC_MAX_BYTES) return 'over'
  if (bytes >= NOTE_SYNC_WARN_BYTES) return 'approaching'
  return 'ok'
}

/**
 * Thrown by `encryptItemForPush` for a payload over the cap. A distinct type
 * because the batch layers have to tell it apart from a genuine crypto failure:
 * it is not retryable and it is the one push failure a user can act on.
 */
export class ItemTooLargeError extends Error {
  readonly code = 'item_too_large' as const

  constructor(
    readonly itemId: string,
    readonly estimatedBytes: number,
    readonly maxBytes: number
  ) {
    const estimatedMB = (estimatedBytes / (1024 * 1024)).toFixed(1)
    super(`Item too large for sync (estimated ${estimatedMB}MB, max ${maxBytes / (1024 * 1024)}MB)`)
    this.name = 'ItemTooLargeError'
  }
}
