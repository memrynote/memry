import { createLogger } from '../lib/logger'
import { deleteBlobs } from './blob'
import { reclaimUnusedPresignedChunks } from './presigned-chunk-reclaim'
import { adjustStorageUsed } from './quota'
import { IDENTIFY_SESSION_TTL_SECONDS } from './telemetry-identify'

const logger = createLogger('Cleanup')

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

// Orphaned chunks reaped per tick, and ids per DELETE (D1 binds at most 100).
// A tick spends one select, then per batch a D1 delete, a D1 re-check and one
// bulk R2 delete: 13 subrequests at the cap.
const ORPHAN_CHUNK_LIMIT = 300
const ORPHAN_CHUNK_BATCH = 90

// Rows shed per tick, and users whose objects are deleted per tick. Each user
// costs one bulk R2 delete and every 50 rows one db.batch, so a tick spends at
// most ~25 subrequests: the scheduled invocation shares its 1000-subrequest
// ceiling with pack_backfill, which budgets 900 for itself (pack-backfill.ts).
const TOMBSTONE_SHED_LIMIT = 200
const TOMBSTONE_SHED_USERS_PER_TICK = 20
// Rows per shed transaction: two statements each, one db.batch per chunk.
const TOMBSTONE_SHED_CHUNK = 50

// An unshed tombstone still holds its payload. `blob_key = ''` is the marker,
// the same predicate as the partial index idx_sync_items_unshed_tombstones.
const UNSHED_GUARD = "id = ? AND server_cursor = ? AND deleted_at IS NOT NULL AND blob_key <> ''"

interface ExpiredTombstoneRow {
  id: string
  blob_key: string
  user_id: string
  size_bytes: number
  server_cursor: number
}

/**
 * Sheds the payload of tombstones past the user's `version_history_days` and
 * keeps each row as a marker (#2302, protocol 05 §5.12.3). Deleting the row
 * is what let a device offline past retention resurrect the item: push
 * Stage 3 found no row, so neither replay detection nor delete-wins ran. The
 * marker keeps `deleted_at`, `clock`, `server_cursor` and the (type, id), so
 * every reader of the delete fact behaves exactly as for a signed tombstone.
 *
 * Order: select, one bulk R2 delete per user (keys are content-addressed per
 * version, so this never hits a newer version), then per chunk one db.batch
 * that refunds and marks each row together. Only rows whose object delete
 * succeeded are marked: a failed delete leaves them unshed for the next tick,
 * never an orphaned object behind a marker. Both statements are guarded on the
 * selected `server_cursor` and on the row still holding its payload, so a push
 * that re-created or re-deleted the item in between leaves it alone, and a
 * re-run refunds nothing twice. A crash after the R2 delete leaves a tombstone
 * without bytes; pull serves it as a purged tombstone and the next run marks
 * it. Returns the number of rows shed.
 *
 * Known gap: a push that read the unshed tombstone (size S) in its Stage 3 and
 * commits after this shed refunds S again through its size delta, so the
 * user's `storage_used` can undercount by S. Bounded, in the user's favour,
 * and needs a push of that exact expired tombstone inside the shed's window.
 */
export const cleanupExpiredTombstones = async (
  db: D1Database,
  storage: R2Bucket
): Promise<number> => {
  const now = Math.floor(Date.now() / 1000)

  const expired = await db
    .prepare(
      `SELECT si.id, si.blob_key, si.user_id, si.size_bytes, si.server_cursor
       FROM sync_items si
       LEFT JOIN sync_entitlements e ON e.user_id = si.user_id
       WHERE si.deleted_at IS NOT NULL
         AND si.blob_key <> ''
         AND si.deleted_at < ? - (COALESCE(e.version_history_days, 0) * 86400)
       ORDER BY si.user_id
       LIMIT ${TOMBSTONE_SHED_LIMIT}`
    )
    .bind(now)
    .all<ExpiredTombstoneRow>()

  const rowsByUser = new Map<string, ExpiredTombstoneRow[]>()
  for (const row of expired.results ?? []) {
    const group = rowsByUser.get(row.user_id)
    if (group) group.push(row)
    else if (rowsByUser.size < TOMBSTONE_SHED_USERS_PER_TICK) rowsByUser.set(row.user_id, [row])
  }

  const deleted: ExpiredTombstoneRow[] = []
  for (const [userId, rows] of rowsByUser) {
    try {
      await deleteBlobs(
        storage,
        rows.map((row) => row.blob_key),
        userId
      )
      deleted.push(...rows)
    } catch (error) {
      logger.warn('Tombstone shed: object delete failed, rows stay unshed for the next tick', {
        rows: rows.length,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  let shed = 0
  for (let i = 0; i < deleted.length; i += TOMBSTONE_SHED_CHUNK) {
    const statements = deleted.slice(i, i + TOMBSTONE_SHED_CHUNK).flatMap((row) => [
      db
        .prepare(
          `UPDATE users SET storage_used = MAX(0, storage_used - ?), updated_at = ?
           WHERE id = ? AND EXISTS (SELECT 1 FROM sync_items WHERE ${UNSHED_GUARD})`
        )
        .bind(row.size_bytes, now, row.user_id, row.id, row.server_cursor),
      db
        .prepare(
          `UPDATE sync_items
           SET blob_key = '', content_hash = '', signature = '', size_bytes = 0, payload_purged_at = ?
           WHERE ${UNSHED_GUARD}`
        )
        .bind(now, row.id, row.server_cursor)
    ])
    const results = await db.batch(statements)
    shed += results.filter(
      (_, index) => index % 2 === 1 && (results[index].meta.changes ?? 0) > 0
    ).length
  }

  return shed
}

export const cleanupOrphanedBlobChunks = async (
  db: D1Database,
  storage: R2Bucket
): Promise<number> => {
  const orphaned = await db
    .prepare(`SELECT id FROM blob_chunks WHERE ref_count <= 0 LIMIT ${ORPHAN_CHUNK_LIMIT}`)
    .all<{ id: string }>()
  const ids = (orphaned.results ?? []).map((row) => row.id)

  let reaped = 0
  for (let start = 0; start < ids.length; start += ORPHAN_CHUNK_BATCH) {
    const batch = ids.slice(start, start + ORPHAN_CHUNK_BATCH)
    // The row goes first, and only while it is still orphaned: an upload of the
    // same hash re-references it (ON CONFLICT ref_count + 1) and needs the object.
    const deleted = await db
      .prepare(
        `DELETE FROM blob_chunks WHERE id IN (${batch.map(() => '?').join(',')}) AND ref_count <= 0
         RETURNING r2_key`
      )
      .bind(...batch)
      .all<{ r2_key: string }>()
    const reapedKeys = (deleted.results ?? []).map((row) => row.r2_key)
    reaped += reapedKeys.length
    if (reapedKeys.length === 0) continue
    // An upload retrying the same bytes puts the object, then inserts a fresh
    // row; skip any key such a row claimed since the delete above.
    const reclaimed = await db
      .prepare(
        `SELECT r2_key FROM blob_chunks WHERE r2_key IN (${reapedKeys.map(() => '?').join(',')})`
      )
      .bind(...reapedKeys)
      .all<{ r2_key: string }>()
    const live = new Set((reclaimed.results ?? []).map((row) => row.r2_key))
    const keys = reapedKeys.filter((key) => !live.has(key))
    if (keys.length === 0) continue
    try {
      await storage.delete(keys)
    } catch (error) {
      // The rows are gone, so the objects are unreferenced; a failed delete only
      // leaks storage, it never removes an object a row still points at.
      logger.warn('Orphaned chunk object delete failed', { count: keys.length, error })
    }
  }
  return reaped
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
