import { generateCrdtKey, getBlob, putBlob } from './blob'
import { adjustStorageUsed, reserveStorage } from './quota'
import type { ClientIdentity } from '../lib/client-identity'
import { createLogger } from '../lib/logger'

const logger = createLogger('CrdtService')

/**
 * Refunds a storage reservation after a failed write.
 *
 * The refund is itself a D1 write, so during a D1 outage it fails too. It must
 * never replace the error that actually caused the write to fail: that turns a
 * typed, handled error into an unhandled one and hides the real cause.
 */
const refundReservation = async (
  db: D1Database,
  userId: string,
  reservedBytes: number,
  context: { operation: string; vaultId: string; noteId: string }
): Promise<void> => {
  if (reservedBytes <= 0) return
  try {
    await adjustStorageUsed(db, userId, -reservedBytes)
  } catch (refundError) {
    // The reservation stays charged to the user until reconciliation.
    logger.error('storage refund failed', {
      ...context,
      reservedBytes,
      error: refundError instanceof Error ? refundError.message : String(refundError)
    })
  }
}

interface CrdtUpdate {
  id: string
  user_id: string
  vault_id: string
  note_id: string
  update_data: ArrayBuffer
  sequence_num: number
  signer_device_id: string
  created_at: number
}

interface CrdtSnapshot {
  id: string
  user_id: string
  vault_id: string
  note_id: string
  blob_key: string
  sequence_num: number
  size_bytes: number
  signer_device_id: string
  created_at: number
  revision: string
}

/**
 * What a client needs to decide whether the server's snapshot for a note moved,
 * without downloading it.
 */
export interface CrdtSnapshotMeta {
  sequenceNum: number
  revision: string
  signerDeviceId: string
}

interface SnapshotRevisionRow {
  id: string
  created_at: number
  size_bytes: number
  revision: string
}

/**
 * Rows written before `revision` existed carry '' (the column default; the
 * migration deliberately does not backfill). They coalesce at READ time to a
 * token derived from the row itself: `id` is never rewritten by the upsert, so
 * it discriminates a deleted-and-recreated row, while `created_at` and
 * `size_bytes` move whenever the blob is replaced.
 *
 * Both read paths -- `getSnapshot` and the batch metadata read -- must produce
 * the SAME string for the same row, or a client comparing the token it merged
 * from the GET against the token the batch advertises would never match, and
 * would re-download every legacy snapshot forever.
 */
const coalesceRevision = (row: SnapshotRevisionRow): string =>
  row.revision !== '' ? row.revision : `legacy:${row.id}:${row.created_at}:${row.size_bytes}`

const getMaxSequenceNumber = async (
  db: D1Database,
  userId: string,
  vaultId: string,
  noteId: string
): Promise<number> => {
  const row = await db
    .prepare(
      `SELECT COALESCE(MAX(sequence_num), 0) as max_seq
       FROM (
         SELECT sequence_num FROM crdt_updates WHERE user_id = ? AND vault_id = ? AND note_id = ?
         UNION ALL
         SELECT sequence_num FROM crdt_snapshots WHERE user_id = ? AND vault_id = ? AND note_id = ?
       )`
    )
    .bind(userId, vaultId, noteId, userId, vaultId, noteId)
    .first<{ max_seq: number | null }>()

  return row?.max_seq ?? 0
}

export const storeUpdates = async (
  db: D1Database,
  userId: string,
  vaultId: string,
  noteId: string,
  signerDeviceId: string,
  updates: ArrayBuffer[],
  client: ClientIdentity | null = null
): Promise<number[]> => {
  if (updates.length === 0) return []

  const totalBytes = updates.reduce((sum, update) => sum + update.byteLength, 0)
  if (totalBytes > 0) {
    await reserveStorage(db, userId, totalBytes)
  }

  const now = Math.floor(Date.now() / 1000)
  // One INSERT-with-MAX-subselect per update, exactly as the old serial loop
  // wrote them, but sent as ONE db.batch: D1 runs the batch sequentially inside
  // a single transaction, so each statement's MAX sees the row the previous
  // statement inserted (sequence numbers stay strictly increasing and gapless)
  // while the batch as a whole is atomic against a concurrent device writing
  // the same note — the property the per-statement loop relied on, at one
  // round trip instead of one per update.
  const statements = updates.map((update) =>
    db
      .prepare(
        `INSERT INTO crdt_updates (id, user_id, vault_id, note_id, update_data, sequence_num, signer_device_id, created_at, client_platform, client_version)
         SELECT ?, ?, ?, ?, ?, COALESCE(MAX(sequence_num), 0) + 1, ?, ?, ?, ?
         FROM (
           SELECT sequence_num FROM crdt_updates WHERE user_id = ? AND vault_id = ? AND note_id = ?
           UNION ALL
           SELECT sequence_num FROM crdt_snapshots WHERE user_id = ? AND vault_id = ? AND note_id = ?
         )
         RETURNING sequence_num`
      )
      .bind(
        crypto.randomUUID(),
        userId,
        vaultId,
        noteId,
        update,
        signerDeviceId,
        now,
        client?.platform ?? null,
        client?.version ?? null,
        userId,
        vaultId,
        noteId,
        userId,
        vaultId,
        noteId
      )
  )

  let results: Array<D1Result<{ sequence_num: number }>>
  try {
    results = await db.batch<{ sequence_num: number }>(statements)
  } catch (error) {
    await refundReservation(db, userId, totalBytes, {
      operation: 'storeUpdates',
      vaultId,
      noteId
    })
    throw error
  }

  return results.map((result) => result.results[0].sequence_num)
}

export const getUpdates = async (
  db: D1Database,
  userId: string,
  vaultId: string,
  noteId: string,
  sinceSequence: number,
  limit = 100
): Promise<{ updates: CrdtUpdate[]; hasMore: boolean }> => {
  const rows = await db
    .prepare(
      'SELECT id, user_id, vault_id, note_id, update_data, sequence_num, signer_device_id, created_at FROM crdt_updates WHERE user_id = ? AND vault_id = ? AND note_id = ? AND sequence_num > ? ORDER BY sequence_num ASC LIMIT ?'
    )
    .bind(userId, vaultId, noteId, sinceSequence, limit + 1)
    .all<CrdtUpdate>()

  const results = rows.results ?? []
  const hasMore = results.length > limit

  return {
    updates: results.slice(0, limit),
    hasMore
  }
}

/**
 * D1 rejects any single query carrying more than 100 bound parameters, and the
 * rejection is a 500 on the whole request, not a partial result. Mirrors the
 * constant in `services/sync.ts`; the margin under 100 is deliberate.
 */
const D1_MAX_BIND_PARAMS = 95

/**
 * The statements that read snapshot metadata for a whole batch of notes.
 *
 * Handed back as prepared statements rather than executed here so
 * `getBatchUpdates` can append them to the `db.batch()` it already sends: extra
 * statements on an existing round trip, not a second round trip.
 *
 * Split at the bind-parameter ceiling. The batch pull accepts up to 100 notes
 * (`CrdtBatchPullSchema`), and user_id + vault_id are bound ahead of the ids, so
 * one statement for a full chunk asked D1 for 102 parameters and failed the
 * entire pull with a 500. That only bites on FULL chunks — a fresh install or a
 * reinstall, where the sweep has enough notes to fill one — which is precisely
 * the case where no device has the bodies yet.
 */
const getBatchSnapshotMeta = (
  db: D1Database,
  userId: string,
  vaultId: string,
  noteIds: string[]
): D1PreparedStatement[] => {
  const perStatement = D1_MAX_BIND_PARAMS - 2
  const statements: D1PreparedStatement[] = []

  for (let i = 0; i < noteIds.length; i += perStatement) {
    const chunk = noteIds.slice(i, i + perStatement)
    statements.push(
      db
        .prepare(
          `SELECT id, note_id, sequence_num, revision, created_at, size_bytes, signer_device_id
       FROM crdt_snapshots
       WHERE user_id = ? AND vault_id = ? AND note_id IN (${chunk.map(() => '?').join(', ')})`
        )
        .bind(userId, vaultId, ...chunk)
    )
  }

  return statements
}

export const getBatchUpdates = async (
  db: D1Database,
  userId: string,
  vaultId: string,
  notes: Array<{ noteId: string; since: number }>,
  limitPerNote: number
): Promise<{
  notes: Record<string, { updates: CrdtUpdate[]; hasMore: boolean }>
  snapshotMeta: Record<string, CrdtSnapshotMeta>
}> => {
  if (notes.length === 0) return { notes: {}, snapshotMeta: {} }

  const statements = notes.map((n) =>
    db
      .prepare(
        'SELECT id, user_id, vault_id, note_id, update_data, sequence_num, signer_device_id, created_at FROM crdt_updates WHERE user_id = ? AND vault_id = ? AND note_id = ? AND sequence_num > ? ORDER BY sequence_num ASC LIMIT ?'
      )
      .bind(userId, vaultId, n.noteId, n.since, limitPerNote + 1)
  )
  statements.push(
    ...getBatchSnapshotMeta(
      db,
      userId,
      vaultId,
      notes.map((n) => n.noteId)
    )
  )

  const batchResults = await db.batch(statements)

  const noteResults: Record<string, { updates: CrdtUpdate[]; hasMore: boolean }> = {}
  for (let i = 0; i < notes.length; i++) {
    const rows = (batchResults[i] as D1Result<CrdtUpdate>).results ?? []
    noteResults[notes[i].noteId] = {
      updates: rows.slice(0, limitPerNote),
      hasMore: rows.length > limitPerNote
    }
  }

  // A note absent from this map has no server snapshot at all.
  const snapshotMeta: Record<string, CrdtSnapshotMeta> = {}
  // Everything past the per-note statements is metadata, however many statements
  // the bind-parameter split turned it into.
  const metaRows = batchResults
    .slice(notes.length)
    .flatMap((result) => (result as D1Result<CrdtSnapshot>).results ?? [])
  for (const row of metaRows) {
    snapshotMeta[row.note_id] = {
      sequenceNum: row.sequence_num,
      revision: coalesceRevision(row),
      signerDeviceId: row.signer_device_id
    }
  }

  return { notes: noteResults, snapshotMeta }
}

export const storeSnapshot = async (
  db: D1Database,
  storage: R2Bucket,
  userId: string,
  vaultId: string,
  noteId: string,
  signerDeviceId: string,
  snapshotData: ArrayBuffer,
  client: ClientIdentity | null = null
): Promise<{ sequenceNum: number }> => {
  const id = crypto.randomUUID()
  // Fresh on EVERY write, insert and conflict alike, and never conditional on
  // whether the bytes look different. A revision that fails to move when the
  // blob does leaves a client skipping a snapshot it needed, with a stale body
  // forever -- the one failure this token exists to prevent.
  const revision = crypto.randomUUID()
  const now = Math.floor(Date.now() / 1000)
  const blobKey = generateCrdtKey(userId, noteId, vaultId)
  const currentSeq = await getMaxSequenceNumber(db, userId, vaultId, noteId)
  const existingSnapshot = await db
    .prepare(
      'SELECT sequence_num, size_bytes FROM crdt_snapshots WHERE user_id = ? AND vault_id = ? AND note_id = ?'
    )
    .bind(userId, vaultId, noteId)
    .first<{ sequence_num: number; size_bytes: number }>()
  // Client-uploaded snapshots do not include causal metadata proving they already
  // contain every server update above the prior snapshot watermark. Keep the
  // watermark stable once a snapshot exists so later incrementals remain pullable.
  const sequenceNum = existingSnapshot?.sequence_num ?? currentSeq

  const deltaBytes = snapshotData.byteLength - (existingSnapshot?.size_bytes ?? 0)
  if (deltaBytes > 0) {
    await reserveStorage(db, userId, deltaBytes)
  }

  try {
    // Goes through putBlob so a transient R2 failure is retried and any
    // remaining failure surfaces as a typed AppError rather than a raw R2
    // Error the error handler can only log as UNHANDLED_ERROR. The put stays
    // ahead of the D1 upsert so a failed put writes no orphan row.
    await putBlob(storage, blobKey, snapshotData, userId)

    await db
      .prepare(
        `INSERT INTO crdt_snapshots (id, user_id, vault_id, note_id, blob_key, sequence_num, size_bytes, signer_device_id, created_at, revision, client_platform, client_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, vault_id, note_id)
         DO UPDATE SET blob_key = excluded.blob_key, sequence_num = excluded.sequence_num, size_bytes = excluded.size_bytes, signer_device_id = excluded.signer_device_id, created_at = excluded.created_at, revision = excluded.revision, client_platform = excluded.client_platform, client_version = excluded.client_version`
      )
      .bind(
        id,
        userId,
        vaultId,
        noteId,
        blobKey,
        sequenceNum,
        snapshotData.byteLength,
        signerDeviceId,
        now,
        revision,
        client?.platform ?? null,
        client?.version ?? null
      )
      .run()
  } catch (error) {
    await refundReservation(db, userId, deltaBytes, {
      operation: 'storeSnapshot',
      vaultId,
      noteId
    })
    throw error
  }

  if (deltaBytes < 0) {
    await adjustStorageUsed(db, userId, deltaBytes)
  }

  return { sequenceNum }
}

export const getSnapshot = async (
  db: D1Database,
  storage: R2Bucket,
  userId: string,
  vaultId: string,
  noteId: string
): Promise<{
  snapshotData: ArrayBuffer
  sequenceNum: number
  signerDeviceId: string
  revision: string
} | null> => {
  const row = await db
    .prepare(
      'SELECT id, blob_key, sequence_num, signer_device_id, created_at, size_bytes, revision FROM crdt_snapshots WHERE user_id = ? AND vault_id = ? AND note_id = ?'
    )
    .bind(userId, vaultId, noteId)
    .first<
      SnapshotRevisionRow & { blob_key: string; sequence_num: number; signer_device_id: string }
    >()

  if (!row) return null

  // Legacy rows predate vault scoping but are still `${userId}/`-prefixed, so
  // the ownership assertion inside getBlob holds for them too.
  const obj = await getBlob(storage, row.blob_key, userId)
  if (!obj) return null

  const snapshotData = await obj.arrayBuffer()
  return {
    snapshotData,
    sequenceNum: row.sequence_num,
    signerDeviceId: row.signer_device_id,
    revision: coalesceRevision(row)
  }
}

export const pruneUpdatesBeforeSnapshot = async (
  db: D1Database,
  userId: string,
  vaultId: string,
  noteId: string
): Promise<number> => {
  const snapshot = await db
    .prepare(
      'SELECT sequence_num FROM crdt_snapshots WHERE user_id = ? AND vault_id = ? AND note_id = ?'
    )
    .bind(userId, vaultId, noteId)
    .first<{ sequence_num: number }>()

  if (!snapshot) return 0

  const bytes = await db
    .prepare(
      'SELECT COALESCE(SUM(length(update_data)), 0) as total_bytes FROM crdt_updates WHERE user_id = ? AND vault_id = ? AND note_id = ? AND sequence_num <= ?'
    )
    .bind(userId, vaultId, noteId, snapshot.sequence_num)
    .first<{ total_bytes: number }>()

  const result = await db
    .prepare(
      'DELETE FROM crdt_updates WHERE user_id = ? AND vault_id = ? AND note_id = ? AND sequence_num <= ?'
    )
    .bind(userId, vaultId, noteId, snapshot.sequence_num)
    .run()

  const changes = result.meta.changes ?? 0
  const totalBytes = Number(bytes?.total_bytes ?? 0)
  if (changes > 0 && totalBytes > 0) {
    await adjustStorageUsed(db, userId, -totalBytes)
  }

  return changes
}
