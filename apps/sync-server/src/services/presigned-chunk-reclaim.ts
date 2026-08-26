import { createLogger } from '../lib/logger'
import { generateAttachmentChunkKey } from './blob'

const logger = createLogger('PresignedChunkReclaim')

/**
 * Contract charset for a chunk hash (64 lowercase hex, see
 * `@memry/contracts/blob-api`). `presigned_chunks` is written only by this
 * server from already-validated hashes, but the value is re-validated before it
 * is spliced into an R2 key so a corrupt column can never widen a delete.
 */
const CHUNK_HASH_PATTERN = /^[a-f0-9]{64}$/

/** D1 caps bound parameters per statement; 90 leaves headroom under 100. */
const D1_BIND_BATCH = 90

/** The subset of an upload_sessions row the reclaim needs. */
export interface PresignedChunkSession {
  user_id: string
  vault_id: string
  /** NULL for sessions that were never handed presigned PUT URLs. */
  presigned_chunks?: string | null
}

/**
 * Read the hashes an upload session armed presigned PUT URLs for.
 *
 * Total by design: this only ever feeds storage-RELEASING paths, so a corrupt
 * or absent column degrades to "nothing to reclaim" rather than blocking an
 * abort or stalling the cron sweep.
 */
export const parsePresignedChunkHashes = (value: string | null | undefined): string[] => {
  if (!value) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const hashes = new Set<string>()
  for (const entry of parsed) {
    if (typeof entry === 'string' && CHUNK_HASH_PATTERN.test(entry)) hashes.add(entry)
  }
  return [...hashes]
}

/**
 * Delete every R2 object an upload session armed a presigned PUT URL for but
 * never registered in `blob_chunks`.
 *
 * Presigned bytes bypass the Worker completely — no hash verification, no size
 * cap, no D1 write — so the armed key list is the ONLY trace that those objects
 * may exist. It must be consumed at every point an upload session row stops
 * existing (complete, abort, expiry sweep), because after the row is gone no
 * sweep can reach those keys: `uploaded_chunks` never saw them and
 * `cleanupOrphanedBlobChunks` only reaps `blob_chunks` rows.
 *
 * Registration is the safety interlock. A hash with a live `blob_chunks` row is
 * real, referenced data — a client is free to declare a hash that already
 * exists, and deleting that object would destroy another attachment's chunk —
 * so those are skipped and left to the ref_count paths that own them.
 *
 * Best effort: a failed R2 delete is logged and the sweep continues, exactly
 * like the other reclaim loops. Deleting a key that was never written is a
 * harmless no-op in R2.
 *
 * Returns the number of keys swept.
 */
export const reclaimUnusedPresignedChunks = async (
  db: D1Database,
  storage: R2Bucket,
  session: PresignedChunkSession
): Promise<number> => {
  const hashes = parsePresignedChunkHashes(session.presigned_chunks)
  if (hashes.length === 0) return 0

  const registered = new Set<string>()
  for (let i = 0; i < hashes.length; i += D1_BIND_BATCH) {
    const slice = hashes.slice(i, i + D1_BIND_BATCH)
    const placeholders = slice.map(() => '?').join(', ')
    const result = await db
      .prepare(
        `SELECT hash FROM blob_chunks WHERE user_id = ? AND vault_id = ? AND hash IN (${placeholders})`
      )
      .bind(session.user_id, session.vault_id, ...slice)
      .all<{ hash: string }>()
    for (const row of result.results ?? []) registered.add(row.hash)
  }

  let reclaimed = 0
  for (const hash of hashes) {
    if (registered.has(hash)) continue
    const key = generateAttachmentChunkKey(session.user_id, session.vault_id, hash)
    try {
      await storage.delete(key)
      reclaimed++
    } catch (error) {
      logger.error('presigned chunk reclaim failed', {
        userId: session.user_id,
        vaultId: session.vault_id,
        key,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  return reclaimed
}
