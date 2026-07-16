import { generateCrdtKey, getBlob, putBlob } from './blob'
import { adjustStorageUsed, reserveStorage } from './quota'
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
}

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
  updates: ArrayBuffer[]
): Promise<number[]> => {
  const sequences: number[] = []
  const totalBytes = updates.reduce((sum, update) => sum + update.byteLength, 0)
  if (totalBytes > 0) {
    await reserveStorage(db, userId, totalBytes)
  }

  try {
    for (const update of updates) {
      const id = crypto.randomUUID()
      const now = Math.floor(Date.now() / 1000)

      const row = await db
        .prepare(
          `INSERT INTO crdt_updates (id, user_id, vault_id, note_id, update_data, sequence_num, signer_device_id, created_at)
           SELECT ?, ?, ?, ?, ?, COALESCE(MAX(sequence_num), 0) + 1, ?, ?
           FROM (
             SELECT sequence_num FROM crdt_updates WHERE user_id = ? AND vault_id = ? AND note_id = ?
             UNION ALL
             SELECT sequence_num FROM crdt_snapshots WHERE user_id = ? AND vault_id = ? AND note_id = ?
           )
           RETURNING sequence_num`
        )
        .bind(
          id,
          userId,
          vaultId,
          noteId,
          update,
          signerDeviceId,
          now,
          userId,
          vaultId,
          noteId,
          userId,
          vaultId,
          noteId
        )
        .first<{ sequence_num: number }>()

      sequences.push(row!.sequence_num)
    }
  } catch (error) {
    await refundReservation(db, userId, totalBytes, {
      operation: 'storeUpdates',
      vaultId,
      noteId
    })
    throw error
  }

  return sequences
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

export const getBatchUpdates = async (
  db: D1Database,
  userId: string,
  vaultId: string,
  notes: Array<{ noteId: string; since: number }>,
  limitPerNote: number
): Promise<Record<string, { updates: CrdtUpdate[]; hasMore: boolean }>> => {
  if (notes.length === 0) return {}

  const statements = notes.map((n) =>
    db
      .prepare(
        'SELECT id, user_id, vault_id, note_id, update_data, sequence_num, signer_device_id, created_at FROM crdt_updates WHERE user_id = ? AND vault_id = ? AND note_id = ? AND sequence_num > ? ORDER BY sequence_num ASC LIMIT ?'
      )
      .bind(userId, vaultId, n.noteId, n.since, limitPerNote + 1)
  )

  const batchResults = await db.batch(statements)

  const result: Record<string, { updates: CrdtUpdate[]; hasMore: boolean }> = {}
  for (let i = 0; i < notes.length; i++) {
    const rows = (batchResults[i] as D1Result<CrdtUpdate>).results ?? []
    result[notes[i].noteId] = {
      updates: rows.slice(0, limitPerNote),
      hasMore: rows.length > limitPerNote
    }
  }
  return result
}

export const storeSnapshot = async (
  db: D1Database,
  storage: R2Bucket,
  userId: string,
  vaultId: string,
  noteId: string,
  signerDeviceId: string,
  snapshotData: ArrayBuffer
): Promise<{ sequenceNum: number }> => {
  const id = crypto.randomUUID()
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
        `INSERT INTO crdt_snapshots (id, user_id, vault_id, note_id, blob_key, sequence_num, size_bytes, signer_device_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, vault_id, note_id)
         DO UPDATE SET blob_key = excluded.blob_key, sequence_num = excluded.sequence_num, size_bytes = excluded.size_bytes, signer_device_id = excluded.signer_device_id, created_at = excluded.created_at`
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
        now
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
): Promise<{ snapshotData: ArrayBuffer; sequenceNum: number; signerDeviceId: string } | null> => {
  const row = await db
    .prepare(
      'SELECT blob_key, sequence_num, signer_device_id FROM crdt_snapshots WHERE user_id = ? AND vault_id = ? AND note_id = ?'
    )
    .bind(userId, vaultId, noteId)
    .first<{ blob_key: string; sequence_num: number; signer_device_id: string }>()

  if (!row) return null

  // Legacy rows predate vault scoping but are still `${userId}/`-prefixed, so
  // the ownership assertion inside getBlob holds for them too.
  const obj = await getBlob(storage, row.blob_key, userId)
  if (!obj) return null

  const snapshotData = await obj.arrayBuffer()
  return { snapshotData, sequenceNum: row.sequence_num, signerDeviceId: row.signer_device_id }
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
