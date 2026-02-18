interface CrdtUpdate {
  id: string
  user_id: string
  note_id: string
  update_data: ArrayBuffer
  sequence_num: number
  signer_device_id: string
  created_at: number
}

interface CrdtSnapshot {
  id: string
  user_id: string
  note_id: string
  blob_key: string
  sequence_num: number
  size_bytes: number
  signer_device_id: string
  created_at: number
}

export const storeUpdates = async (
  db: D1Database,
  userId: string,
  noteId: string,
  signerDeviceId: string,
  updates: ArrayBuffer[]
): Promise<number[]> => {
  const sequences: number[] = []

  for (const update of updates) {
    const id = crypto.randomUUID()
    const now = Math.floor(Date.now() / 1000)

    const row = await db
      .prepare(
        `INSERT INTO crdt_updates (id, user_id, note_id, update_data, sequence_num, signer_device_id, created_at)
         SELECT ?, ?, ?, ?, COALESCE(MAX(sequence_num), 0) + 1, ?, ?
         FROM crdt_updates WHERE user_id = ? AND note_id = ?
         RETURNING sequence_num`
      )
      .bind(id, userId, noteId, update, signerDeviceId, now, userId, noteId)
      .first<{ sequence_num: number }>()

    sequences.push(row!.sequence_num)
  }

  return sequences
}

export const getUpdates = async (
  db: D1Database,
  userId: string,
  noteId: string,
  sinceSequence: number,
  limit = 100
): Promise<{ updates: CrdtUpdate[]; hasMore: boolean }> => {
  const rows = await db
    .prepare(
      'SELECT id, user_id, note_id, update_data, sequence_num, signer_device_id, created_at FROM crdt_updates WHERE user_id = ? AND note_id = ? AND sequence_num > ? ORDER BY sequence_num ASC LIMIT ?'
    )
    .bind(userId, noteId, sinceSequence, limit + 1)
    .all<CrdtUpdate>()

  const results = rows.results ?? []
  const hasMore = results.length > limit

  return {
    updates: results.slice(0, limit),
    hasMore
  }
}

export const storeSnapshot = async (
  db: D1Database,
  storage: R2Bucket,
  userId: string,
  noteId: string,
  signerDeviceId: string,
  snapshotData: ArrayBuffer
): Promise<{ sequenceNum: number }> => {
  const id = crypto.randomUUID()
  const now = Math.floor(Date.now() / 1000)
  const blobKey = `${userId}/crdt/${noteId}/snapshot`

  await storage.put(blobKey, snapshotData)

  const currentSeq = await db
    .prepare(
      'SELECT COALESCE(MAX(sequence_num), 0) as max_seq FROM crdt_updates WHERE user_id = ? AND note_id = ?'
    )
    .bind(userId, noteId)
    .first<{ max_seq: number }>()

  const sequenceNum = currentSeq?.max_seq ?? 0

  await db
    .prepare(
      `INSERT INTO crdt_snapshots (id, user_id, note_id, blob_key, sequence_num, size_bytes, signer_device_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, note_id)
       DO UPDATE SET blob_key = excluded.blob_key, sequence_num = excluded.sequence_num, size_bytes = excluded.size_bytes, signer_device_id = excluded.signer_device_id, created_at = excluded.created_at`
    )
    .bind(id, userId, noteId, blobKey, sequenceNum, snapshotData.byteLength, signerDeviceId, now)
    .run()

  return { sequenceNum }
}

export const getSnapshot = async (
  db: D1Database,
  storage: R2Bucket,
  userId: string,
  noteId: string
): Promise<{ snapshotData: ArrayBuffer; sequenceNum: number; signerDeviceId: string } | null> => {
  const row = await db
    .prepare(
      'SELECT blob_key, sequence_num, signer_device_id FROM crdt_snapshots WHERE user_id = ? AND note_id = ?'
    )
    .bind(userId, noteId)
    .first<{ blob_key: string; sequence_num: number; signer_device_id: string }>()

  if (!row) return null

  const obj = await storage.get(row.blob_key)
  if (!obj) return null

  const snapshotData = await obj.arrayBuffer()
  return { snapshotData, sequenceNum: row.sequence_num, signerDeviceId: row.signer_device_id }
}

export const pruneUpdatesBeforeSnapshot = async (
  db: D1Database,
  userId: string,
  noteId: string
): Promise<number> => {
  const snapshot = await db
    .prepare('SELECT sequence_num FROM crdt_snapshots WHERE user_id = ? AND note_id = ?')
    .bind(userId, noteId)
    .first<{ sequence_num: number }>()

  if (!snapshot) return 0

  const result = await db
    .prepare('DELETE FROM crdt_updates WHERE user_id = ? AND note_id = ? AND sequence_num <= ?')
    .bind(userId, noteId, snapshot.sequence_num)
    .run()

  return result.meta.changes ?? 0
}
