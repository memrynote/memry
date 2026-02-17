interface CrdtUpdate {
  id: string
  user_id: string
  note_id: string
  update_data: ArrayBuffer
  sequence_num: number
  created_at: number
}

interface CrdtSnapshot {
  id: string
  user_id: string
  note_id: string
  sequence_num: number
  size_bytes: number
  created_at: number
}

export const storeUpdates = async (
  db: D1Database,
  userId: string,
  noteId: string,
  updates: ArrayBuffer[]
): Promise<number[]> => {
  const sequences: number[] = []

  for (const update of updates) {
    const id = crypto.randomUUID()
    const now = Math.floor(Date.now() / 1000)

    const currentSeq = await db
      .prepare(
        'SELECT COALESCE(MAX(sequence_num), 0) as max_seq FROM crdt_updates WHERE user_id = ? AND note_id = ?'
      )
      .bind(userId, noteId)
      .first<{ max_seq: number }>()

    const nextSeq = (currentSeq?.max_seq ?? 0) + 1

    await db
      .prepare(
        'INSERT INTO crdt_updates (id, user_id, note_id, update_data, sequence_num, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .bind(id, userId, noteId, update, nextSeq, now)
      .run()

    sequences.push(nextSeq)
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
      'SELECT id, user_id, note_id, update_data, sequence_num, created_at FROM crdt_updates WHERE user_id = ? AND note_id = ? AND sequence_num > ? ORDER BY sequence_num ASC LIMIT ?'
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
      `INSERT INTO crdt_snapshots (id, user_id, note_id, snapshot_data, sequence_num, size_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, note_id)
       DO UPDATE SET snapshot_data = excluded.snapshot_data, sequence_num = excluded.sequence_num, size_bytes = excluded.size_bytes, created_at = excluded.created_at`
    )
    .bind(id, userId, noteId, snapshotData, sequenceNum, snapshotData.byteLength, now)
    .run()

  return { sequenceNum }
}

export const getSnapshot = async (
  db: D1Database,
  storage: R2Bucket,
  userId: string,
  noteId: string
): Promise<{ snapshotData: ArrayBuffer; sequenceNum: number } | null> => {
  const row = await db
    .prepare(
      'SELECT sequence_num FROM crdt_snapshots WHERE user_id = ? AND note_id = ?'
    )
    .bind(userId, noteId)
    .first<{ sequence_num: number }>()

  if (!row) return null

  const blobKey = `${userId}/crdt/${noteId}/snapshot`
  const obj = await storage.get(blobKey)
  if (!obj) return null

  const snapshotData = await obj.arrayBuffer()
  return { snapshotData, sequenceNum: row.sequence_num }
}

export const pruneUpdatesBeforeSnapshot = async (
  db: D1Database,
  userId: string,
  noteId: string
): Promise<number> => {
  const snapshot = await db
    .prepare(
      'SELECT sequence_num FROM crdt_snapshots WHERE user_id = ? AND note_id = ?'
    )
    .bind(userId, noteId)
    .first<{ sequence_num: number }>()

  if (!snapshot) return 0

  const result = await db
    .prepare(
      'DELETE FROM crdt_updates WHERE user_id = ? AND note_id = ? AND sequence_num <= ?'
    )
    .bind(userId, noteId, snapshot.sequence_num)
    .run()

  return result.meta.changes ?? 0
}
