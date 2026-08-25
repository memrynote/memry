import { reclaimUnusedPresignedChunks } from './presigned-chunk-reclaim'
import { adjustStorageUsed } from './quota'
import { IDENTIFY_SESSION_TTL_SECONDS } from './telemetry-identify'

export const cleanupExpiredOtpCodes = async (db: D1Database): Promise<number> => {
  const now = Math.floor(Date.now() / 1000)
  const result = await db.prepare('DELETE FROM otp_codes WHERE expires_at < ?').bind(now).run()
  return result.meta.changes ?? 0
}

export const cleanupExpiredLinkingSessions = async (db: D1Database): Promise<number> => {
  const now = Math.floor(Date.now() / 1000)
  const result = await db
    .prepare('DELETE FROM linking_sessions WHERE expires_at < ?')
    .bind(now)
    .run()
  return result.meta.changes ?? 0
}

// Bootstrap session ledger rows (#1837) are bookkeeping only — the signed
// tokens expire themselves — so this sweep reclaims rows that a client never
// closed and issuance's per-user lazy prune did not reach.
export const cleanupExpiredBootstrapSessions = async (db: D1Database): Promise<number> => {
  const now = Math.floor(Date.now() / 1000)
  const result = await db
    .prepare('DELETE FROM bootstrap_sessions WHERE expires_at < ?')
    .bind(now)
    .run()
  return result.meta.changes ?? 0
}

export const cleanupExpiredUploadSessions = async (
  db: D1Database,
  storage: R2Bucket
): Promise<number> => {
  const now = Math.floor(Date.now() / 1000)

  const stale = await db
    .prepare(
      `SELECT id, user_id, vault_id, total_size, chunk_count, encrypted_size, uploaded_chunks, presigned_chunks, r2_upload_id, r2_key
       FROM upload_sessions
       WHERE expires_at < ?`
    )
    .bind(now)
    .all<{
      id: string
      user_id: string
      vault_id: string
      total_size: number
      chunk_count: number
      encrypted_size: number | null
      uploaded_chunks: string
      presigned_chunks: string | null
      r2_upload_id: string | null
      r2_key: string | null
    }>()

  let cleaned = 0
  for (const session of stale.results ?? []) {
    if (session.r2_upload_id && session.r2_key) {
      try {
        await storage.resumeMultipartUpload(session.r2_key, session.r2_upload_id).abort()
      } catch {
        // Multipart upload may already be completed or expired
      }
    }

    // Presigned PUTs never transited the Worker, so an abandoned session's armed
    // keys appear in neither `uploaded_chunks` (proxied appends only) nor
    // `blob_chunks` (written at complete time) — the loop below cannot see them
    // and `cleanupOrphanedBlobChunks` has no row to reap. Runs first, while
    // blob_chunks still holds a row for every registered hash: anything real is
    // skipped and left to the ref_count handling below.
    await reclaimUnusedPresignedChunks(db, storage, session)

    const uploadedChunks = parseUploadedChunkHashes(session.uploaded_chunks)
    for (const hash of uploadedChunks) {
      const chunk = await db
        .prepare(
          'SELECT id, ref_count, r2_key FROM blob_chunks WHERE user_id = ? AND vault_id = ? AND hash = ?'
        )
        .bind(session.user_id, session.vault_id, hash)
        .first<{ id: string; ref_count: number; r2_key: string }>()

      if (!chunk) continue

      if (chunk.ref_count <= 1) {
        try {
          await storage.delete(chunk.r2_key)
        } catch {
          // R2 delete may fail if chunk already disappeared; proceed with D1 cleanup
        }
        await db.prepare('DELETE FROM blob_chunks WHERE id = ?').bind(chunk.id).run()
      } else {
        await db
          .prepare('UPDATE blob_chunks SET ref_count = ref_count - 1 WHERE id = ?')
          .bind(chunk.id)
          .run()
      }
    }

    const result = await db
      .prepare('DELETE FROM upload_sessions WHERE id = ? AND user_id = ? AND vault_id = ?')
      .bind(session.id, session.user_id, session.vault_id)
      .run()

    if ((result.meta.changes ?? 0) > 0) {
      // Refund exactly what initiate reserved — never re-derive it. `encrypted_size`
      // records the reservation; a NULL means the row was written by the old server,
      // which reserved the plaintext total_size. Migration 0002 deliberately does NOT
      // backfill, so those rows stay NULL permanently (and the old worker can still open
      // fresh NULL rows during the migrate-then-deploy window). The `?? total_size`
      // fallback is load-bearing — do not remove it, and do not add a backfill: it would
      // false-413 the last chunk of every in-flight session (see migrations/0002).
      await adjustStorageUsed(db, session.user_id, -(session.encrypted_size ?? session.total_size))
      cleaned += result.meta.changes ?? 0
    }
  }

  return cleaned
}

export const cleanupConsumedSetupTokens = async (db: D1Database): Promise<number> => {
  const now = Math.floor(Date.now() / 1000)
  const result = await db
    .prepare('DELETE FROM consumed_setup_tokens WHERE expires_at < ?')
    .bind(now)
    .run()
  return result.meta.changes ?? 0
}

export const cleanupExpiredGoogleCalendarChannels = async (db: D1Database): Promise<number> => {
  const now = Math.floor(Date.now() / 1000)
  const result = await db
    .prepare('DELETE FROM google_calendar_channels WHERE expires_at < ?')
    .bind(now)
    .run()
  return result.meta.changes ?? 0
}

export const cleanupStaleRateLimits = async (db: D1Database): Promise<number> => {
  const oneHourAgo = Math.floor(Date.now() / 1000) - 3600
  const result = await db
    .prepare('DELETE FROM rate_limits WHERE window_start < ?')
    .bind(oneHourAgo)
    .run()
  return result.meta.changes ?? 0
}

export const cleanupStaleIdentifySessions = async (db: D1Database): Promise<number> => {
  const cutoff = Math.floor(Date.now() / 1000) - IDENTIFY_SESSION_TTL_SECONDS
  const result = await db
    .prepare('DELETE FROM telemetry_identify_sessions WHERE created_at < ?')
    .bind(cutoff)
    .run()
  return result.meta.changes ?? 0
}

const CLEANUP_BATCH_SIZE = 1000

// Best-effort delete each row's R2 blob, then batch-delete the D1 rows by id.
// ponytail: table is a hardcoded caller literal, not user input — safe to interpolate.
const deleteRowsAndBlobs = async <T extends { id: string }>(
  db: D1Database,
  storage: R2Bucket,
  table: string,
  rows: T[],
  blobKeyOf: (row: T) => string
): Promise<number> => {
  for (const row of rows) {
    try {
      await storage.delete(blobKeyOf(row))
    } catch {
      // R2 delete may fail if blob already removed; proceed with D1 cleanup
    }
  }

  const ids = rows.map((r) => r.id)
  const placeholders = ids.map(() => '?').join(',')
  const result = await db
    .prepare(`DELETE FROM ${table} WHERE id IN (${placeholders})`)
    .bind(...ids)
    .run()

  return result.meta.changes ?? 0
}

export const cleanupExpiredTombstones = async (
  db: D1Database,
  storage: R2Bucket
): Promise<number> => {
  const now = Math.floor(Date.now() / 1000)

  const expired = await db
    .prepare(
      `SELECT si.id, si.blob_key, si.user_id, si.size_bytes
       FROM sync_items si
       LEFT JOIN sync_entitlements e ON e.user_id = si.user_id
       WHERE si.deleted_at IS NOT NULL
         AND si.deleted_at < ? - (COALESCE(e.version_history_days, 0) * 86400)
       LIMIT ${CLEANUP_BATCH_SIZE}`
    )
    .bind(now)
    .all<{ id: string; blob_key: string; user_id: string; size_bytes: number }>()

  const rows = expired.results ?? []
  if (rows.length === 0) return 0

  const changes = await deleteRowsAndBlobs(db, storage, 'sync_items', rows, (r) => r.blob_key)
  if (changes > 0) {
    const bytesByUser = new Map<string, number>()
    for (const row of rows) {
      bytesByUser.set(row.user_id, (bytesByUser.get(row.user_id) ?? 0) + row.size_bytes)
    }

    const timestamp = Math.floor(Date.now() / 1000)
    await Promise.all(
      [...bytesByUser.entries()].map(([userId, bytes]) =>
        db
          .prepare(
            'UPDATE users SET storage_used = MAX(0, storage_used - ?), updated_at = ? WHERE id = ?'
          )
          .bind(bytes, timestamp, userId)
          .run()
      )
    )
  }

  return changes
}

export const cleanupOrphanedBlobChunks = async (
  db: D1Database,
  storage: R2Bucket
): Promise<number> => {
  const orphaned = await db
    .prepare(`SELECT id, r2_key FROM blob_chunks WHERE ref_count <= 0 LIMIT ${CLEANUP_BATCH_SIZE}`)
    .all<{ id: string; r2_key: string }>()

  const rows = orphaned.results ?? []
  if (rows.length === 0) return 0

  return deleteRowsAndBlobs(db, storage, 'blob_chunks', rows, (r) => r.r2_key)
}

const parseUploadedChunkHashes = (value: string): Set<string> => {
  try {
    const parsed = JSON.parse(value) as Array<{ h?: unknown }>
    if (!Array.isArray(parsed)) return new Set()
    const hashes = parsed.flatMap((entry) => (typeof entry.h === 'string' ? [entry.h] : []))
    return new Set(hashes)
  } catch {
    return new Set()
  }
}
