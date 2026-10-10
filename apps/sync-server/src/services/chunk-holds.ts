/**
 * Idempotent chunk holds (#3022, protocol 14 §14.8).
 *
 * `blob_chunks.ref_count` counts uploads. A client that reuses an image it
 * already stored (a second canvas showing the same picture) cannot raise that
 * count without re-sending the bytes, so a peer's release could free chunks the
 * reuse still needs. A hold closes that gap: it is a row keyed by an opaque
 * holder id the client derives per (canvas, image), so a retry, or a second
 * device holding the same pair, writes the same row instead of a second count.
 *
 * A chunk is live while `ref_count > 0` or a hold names it. Holding a dead
 * chunk is refused (its bytes were refunded and the reaper may already have
 * deleted them), so the client re-uploads instead. The last of (ref, hold) to
 * go refunds the chunk's bytes, exactly once.
 */

import { adjustStorageUsed } from './quota'

/** SQL predicate: some hold names the `blob_chunks` row referred to as `chunk`. */
export const chunkHeldSql = (
  chunk: string
): string => `EXISTS (SELECT 1 FROM attachment_chunk_holds h
  WHERE h.user_id = ${chunk}.user_id AND h.vault_id = ${chunk}.vault_id AND h.chunk_hash = ${chunk}.hash)`

// D1 caps a statement at 100 bound parameters.
const BIND_SLICE = 90

export interface ChunkHold {
  holderId: string
  chunkHashes: string[]
}

/**
 * Holds each holder's chunks. Returns the holders that could not be held
 * because a chunk is gone or dead; the client re-uploads those. A partially
 * held holder stays partially held until it is released, which keeps no dead
 * chunk alive: every insert re-checks liveness in the same statement.
 */
export const holdChunks = async (
  db: D1Database,
  userId: string,
  vaultId: string,
  holds: ChunkHold[],
  now = Math.floor(Date.now() / 1000)
): Promise<string[]> => {
  const missing: string[] = []
  for (const { holderId, chunkHashes } of holds) {
    const hashes = [...new Set(chunkHashes)]
    await db.batch(
      hashes.map((hash) =>
        db
          .prepare(
            `INSERT OR IGNORE INTO attachment_chunk_holds (user_id, vault_id, holder_id, chunk_hash, created_at)
             SELECT ?, ?, ?, ?, ? WHERE EXISTS (
               SELECT 1 FROM blob_chunks c WHERE c.user_id = ? AND c.vault_id = ? AND c.hash = ?
                 AND (c.ref_count > 0 OR ${chunkHeldSql('c')}))`
          )
          .bind(userId, vaultId, holderId, hash, now, userId, vaultId, hash)
      )
    )
    let held = 0
    for (let i = 0; i < hashes.length; i += BIND_SLICE) {
      const slice = hashes.slice(i, i + BIND_SLICE)
      held +=
        (await db
          .prepare(
            `SELECT COUNT(*) AS n FROM attachment_chunk_holds
             WHERE user_id = ? AND vault_id = ? AND holder_id = ? AND chunk_hash IN (${slice.map(() => '?').join(', ')})`
          )
          .bind(userId, vaultId, holderId, ...slice)
          .first<number>('n')) ?? 0
    }
    if (held < hashes.length) missing.push(holderId)
  }
  return missing
}

/**
 * Drops every hold of these holders. A replay finds no rows and changes
 * nothing. A chunk left with no hold and no ref refunds its bytes here.
 */
export const releaseHolds = async (
  db: D1Database,
  userId: string,
  vaultId: string,
  holderIds: string[]
): Promise<number> => {
  let released = 0
  for (const holderId of new Set(holderIds)) {
    const rows = await db
      .prepare(
        `DELETE FROM attachment_chunk_holds WHERE user_id = ? AND vault_id = ? AND holder_id = ?
         RETURNING chunk_hash`
      )
      .bind(userId, vaultId, holderId)
      .all<{ chunk_hash: string }>()
    for (const { chunk_hash: hash } of rows.results ?? []) {
      released++
      const freed = await db
        .prepare(
          `SELECT size_bytes FROM blob_chunks c
           WHERE c.user_id = ? AND c.vault_id = ? AND c.hash = ? AND c.ref_count <= 0
             AND NOT ${chunkHeldSql('c')}`
        )
        .bind(userId, vaultId, hash)
        .first<number>('size_bytes')
      if (freed !== null) await adjustStorageUsed(db, userId, -freed)
    }
  }
  return released
}
