import type { NoteBodyChange } from '@memry/contracts/sync-api'
import { generateCrdtKey, getBlob, putBlob } from './blob'
import type { FeedSourceBuilder } from './change-feed'
import { reserveCursors, type CursorReservation } from './cursor'
import { adjustStorageUsed, reserveStorage } from './quota'
import type { ClientIdentity } from '../lib/client-identity'
import { safeBase64Encode } from '../lib/encoding'
import { AppError, ErrorCodes } from '../lib/errors'
import { createLogger } from '../lib/logger'
import {
  coalesceRevision,
  D1_MAX_BIND_PARAMS,
  refundReservation,
  type SnapshotRevisionRow
} from './crdt-shared'

const logger = createLogger('CrdtService')

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

export const storeUpdates = async (
  db: D1Database,
  userId: string,
  vaultId: string,
  noteId: string,
  signerDeviceId: string,
  updates: ArrayBuffer[],
  client: ClientIdentity | null = null
): Promise<number[]> =>
  (await storeUpdatesWithCursor(db, userId, vaultId, noteId, signerDeviceId, updates, client))
    .sequences

/**
 * `storeUpdates`, plus `cursor`: the highest server_cursor among the rows this
 * call inserted (#2420). Absent when every update was already stored, since a
 * duplicate's reserved cursor stays unused and names no row.
 */
export const storeUpdatesWithCursor = async (
  db: D1Database,
  userId: string,
  vaultId: string,
  noteId: string,
  signerDeviceId: string,
  updates: ArrayBuffer[],
  client: ClientIdentity | null = null
): Promise<{ sequences: number[]; cursor?: number }> => {
  if (updates.length === 0) return { sequences: [] }

  const ids = updates.map(() => crypto.randomUUID())
  const hashes = await Promise.all(
    updates.map(async (update) =>
      Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', update)), (byte) =>
        byte.toString(16).padStart(2, '0')
      ).join('')
    )
  )

  // Reserve only the bytes this request will really store (#2296): a retry of
  // bytes the note already holds needs no new storage, so a quota that filled
  // up since the first attempt must not refuse it. Chunked at the bind ceiling:
  // user, vault and note ride ahead of the hashes.
  const distinctHashes = [...new Set(hashes)]
  const hashChunkSize = D1_MAX_BIND_PARAMS - 3
  const lookups: D1PreparedStatement[] = []
  for (let i = 0; i < distinctHashes.length; i += hashChunkSize) {
    const chunk = distinctHashes.slice(i, i + hashChunkSize)
    lookups.push(
      db
        .prepare(
          `SELECT update_hash FROM crdt_updates
           WHERE user_id = ? AND vault_id = ? AND note_id = ? AND update_hash IN (${chunk.map(() => '?').join(', ')})`
        )
        .bind(userId, vaultId, noteId, ...chunk)
    )
  }
  const knownHashes = new Set(
    (await db.batch<{ update_hash: string }>(lookups)).flatMap((result) =>
      (result.results ?? []).map((row) => row.update_hash)
    )
  )
  let reservedBytes = 0
  updates.forEach((update, position) => {
    if (knownHashes.has(hashes[position])) return
    knownHashes.add(hashes[position])
    reservedBytes += update.byteLength
  })
  if (reservedBytes > 0) {
    await reserveStorage(db, userId, reservedBytes)
  }

  const now = Math.floor(Date.now() / 1000)
  // One INSERT-with-MAX-subselect per update, exactly as the old serial loop
  // wrote them, but sent as ONE db.batch: D1 runs the batch sequentially inside
  // a single transaction, so each statement's MAX sees the row the previous
  // statement inserted (sequence numbers stay strictly increasing and gapless)
  // while the batch as a whole is atomic against a concurrent device writing
  // the same note — the property the per-statement loop relied on, at one
  // round trip instead of one per update. The feed cursors are reserved in the
  // same batch (#2295), so no reader can see a cursor above a row that has not
  // committed.
  //
  // Idempotent per note (#2296). Every packed envelope carries a fresh nonce,
  // so identical bytes are a retried push, never a new edit. INSERT OR IGNORE
  // on the (note, update_hash) unique index keeps one row, and the SELECT in
  // the same batch answers the sequence number the stored row has, whichever
  // request wrote it. An ignored row leaves its reserved cursor unused.
  const cursors = reserveCursors(db, userId, updates.length)
  const statements = updates.flatMap((update, position) => [
    db
      .prepare(
        `INSERT OR IGNORE INTO crdt_updates (id, user_id, vault_id, note_id, update_data, sequence_num, signer_device_id, created_at, client_platform, client_version, update_hash, server_cursor)
         SELECT ?, ?, ?, ?, ?, COALESCE(MAX(sequence_num), 0) + 1, ?, ?, ?, ?, ?, ${cursors.cursorSql}
         FROM (
           SELECT sequence_num FROM crdt_updates WHERE user_id = ? AND vault_id = ? AND note_id = ?
           UNION ALL
           SELECT sequence_num FROM crdt_snapshots WHERE user_id = ? AND vault_id = ? AND note_id = ?
         )`
      )
      .bind(
        ids[position],
        userId,
        vaultId,
        noteId,
        update,
        signerDeviceId,
        now,
        client?.platform ?? null,
        client?.version ?? null,
        hashes[position],
        ...cursors.cursorBinds(position),
        userId,
        vaultId,
        noteId,
        userId,
        vaultId,
        noteId
      ),
    db
      .prepare(
        'SELECT id, sequence_num FROM crdt_updates WHERE user_id = ? AND vault_id = ? AND note_id = ? AND update_hash = ?'
      )
      .bind(userId, vaultId, noteId, hashes[position])
  ])

  let results: D1Result[]
  try {
    results = await db.batch(cursors.batch(statements))
  } catch (error) {
    await refundReservation(db, userId, reservedBytes, {
      operation: 'storeUpdates',
      vaultId,
      noteId
    })
    throw error
  }

  const writeResults = results.slice(results.length - statements.length)
  let storedBytes = 0
  let cursor: number | undefined
  const sequences = updates.map((update, position) => {
    const [stored] = writeResults[position * 2 + 1].results as Array<{
      id: string
      sequence_num: number
    }>
    if (stored.id === ids[position]) {
      storedBytes += update.byteLength
      cursor = cursors.cursorAt(results, position)
    }
    return stored.sequence_num
  })

  // The lookup can race a concurrent write of the same note. An update that
  // became a duplicate after the lookup stored nothing: refund it. One whose
  // row was pruned after the lookup was stored uncharged: charge it now,
  // logging rather than failing a write that already committed.
  if (storedBytes < reservedBytes) {
    await refundReservation(db, userId, reservedBytes - storedBytes, {
      operation: 'storeUpdates',
      vaultId,
      noteId
    })
  } else if (storedBytes > reservedBytes) {
    try {
      await adjustStorageUsed(db, userId, storedBytes - reservedBytes)
    } catch (chargeError) {
      logger.error('storage charge failed', {
        operation: 'storeUpdates',
        vaultId,
        noteId,
        chargeBytes: storedBytes - reservedBytes,
        error: chargeError instanceof Error ? chargeError.message : String(chargeError)
      })
    }
  }

  return cursor === undefined ? { sequences } : { sequences, cursor }
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

/**
 * One note's snapshot metadata for the single-note update pull (#2299): a
 * `coversThrough` push moves the watermark, and a reader whose cursor sits
 * between the old and the new one must see the snapshot ahead of it (07 §7.8).
 * Read after the updates, so a prune landing in between shows up as a newer
 * snapshot (an extra baseline), never as a missing one.
 */
export const getSnapshotMeta = async (
  db: D1Database,
  userId: string,
  vaultId: string,
  noteId: string
): Promise<CrdtSnapshotMeta | null> => {
  const [statement] = getBatchSnapshotMeta(db, userId, vaultId, [noteId])
  const row = await statement.first<CrdtSnapshot>()
  return row
    ? {
        sequenceNum: row.sequence_num,
        revision: coalesceRevision(row),
        signerDeviceId: row.signer_device_id
      }
    : null
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

export {
  storeSnapshot,
  storeSnapshotBatch,
  type SnapshotBatchInput,
  type SnapshotBatchOutcome,
  type SnapshotClaim
} from './crdt-snapshot-write'

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
  const readRow = () =>
    db
      .prepare(
        'SELECT id, blob_key, sequence_num, signer_device_id, created_at, size_bytes, revision FROM crdt_snapshots WHERE user_id = ? AND vault_id = ? AND note_id = ?'
      )
      .bind(userId, vaultId, noteId)
      .first<
        SnapshotRevisionRow & { blob_key: string; sequence_num: number; signer_device_id: string }
      >()

  let row = await readRow()
  if (!row) return null

  // Legacy rows predate vault scoping but are still `${userId}/`-prefixed, so
  // the ownership assertion inside getBlob holds for them too.
  let obj = await getBlob(storage, row.blob_key, userId)
  if (!obj) {
    // A replace commits its new key, then deletes the old object (#2299), so a
    // reader that read the row first can miss. "No snapshot" is never the
    // answer for an existing row: a client would take it as verified-empty and
    // seed from markdown. Re-read once; the row gone is a real delete.
    const current = await readRow()
    if (!current) return null
    obj =
      current.blob_key === row.blob_key ? null : await getBlob(storage, current.blob_key, userId)
    if (!obj) {
      throw new AppError(ErrorCodes.STORAGE_BLOB_NOT_FOUND, 'Snapshot object unavailable', 503)
    }
    row = current
  }

  const snapshotData = await obj.arrayBuffer()
  return {
    snapshotData,
    sequenceNum: row.sequence_num,
    signerDeviceId: row.signer_device_id,
    revision: coalesceRevision(row)
  }
}

/**
 * Updates up to this many stored bytes are inlined in a /sync/changes body
 * entry; a larger one is served as a ref without `data` (#2295). A page is
 * clamped to 100 rows when bodies are negotiated, so this bounds the inlined
 * bytes of one page. Staging on 2026-09-25 had p50 212 B, p99 287 B, max
 * 332 B over 11 rows, so nearly every update inlines.
 */
export const NOTE_BODY_INLINE_MAX_BYTES = 4 * 1024

interface NoteBodyFeedRow {
  op: 'update' | 'snapshot'
  note_id: string
  server_cursor: number
  sequence_num: number
  signer_device_id: string
  created_at: number
  size: number
  data: ArrayBuffer | ArrayLike<number> | null
  snapshot_id: string | null
  revision: string | null
}

const toNoteBodyChange = (row: NoteBodyFeedRow): NoteBodyChange => {
  const base = {
    noteId: row.note_id,
    cursor: row.server_cursor,
    signerDeviceId: row.signer_device_id,
    createdAt: row.created_at,
    size: row.size
  }
  if (row.op === 'update') {
    return {
      op: 'update',
      ...base,
      sequenceNum: row.sequence_num,
      ...(row.data !== null ? { data: safeBase64Encode(row.data) } : {})
    }
  }
  return {
    op: 'snapshot',
    ...base,
    sequenceNum: row.sequence_num,
    // The same token GET /sync/crdt/snapshot and snapshotMeta return.
    revision: coalesceRevision({
      id: row.snapshot_id as string,
      created_at: row.created_at,
      size_bytes: row.size,
      revision: row.revision ?? ''
    })
  }
}

/**
 * The note-body half of a /sync/changes page (#2295): both CRDT tables in one
 * statement, ascending by server_cursor. Rows written before migration 0011
 * carry a NULL cursor and never match `server_cursor > ?`.
 */
export const noteBodyFeedSource =
  (db: D1Database, userId: string, vaultId: string): FeedSourceBuilder<NoteBodyChange> =>
  (after, fetchLimit) => ({
    statement: db
      .prepare(
        `SELECT 'update' AS op, note_id, server_cursor, sequence_num, signer_device_id, created_at,
                length(update_data) AS size,
                CASE WHEN length(update_data) <= ${NOTE_BODY_INLINE_MAX_BYTES} THEN update_data END AS data,
                NULL AS snapshot_id, NULL AS revision
         FROM crdt_updates WHERE user_id = ? AND vault_id = ? AND server_cursor > ?
         UNION ALL
         SELECT 'snapshot', note_id, server_cursor, sequence_num, signer_device_id, created_at,
                size_bytes, NULL, id, revision
         FROM crdt_snapshots WHERE user_id = ? AND vault_id = ? AND server_cursor > ?
         ORDER BY server_cursor ASC
         LIMIT ?`
      )
      .bind(userId, vaultId, after, userId, vaultId, after, fetchLimit),
    parse: (rows) =>
      (rows as NoteBodyFeedRow[]).map((row) => ({
        cursor: row.server_cursor,
        value: toNoteBodyChange(row)
      }))
  })

const PRUNE_SUM_SQL =
  'SELECT COALESCE(SUM(length(update_data)), 0) as total_bytes FROM crdt_updates WHERE user_id = ? AND vault_id = ? AND note_id = ? AND sequence_num <= ?'
const PRUNE_DELETE_SQL =
  'DELETE FROM crdt_updates WHERE user_id = ? AND vault_id = ? AND note_id = ? AND sequence_num <= ?'

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
    .prepare(PRUNE_SUM_SQL)
    .bind(userId, vaultId, noteId, snapshot.sequence_num)
    .first<{ total_bytes: number }>()

  const result = await db
    .prepare(PRUNE_DELETE_SQL)
    .bind(userId, vaultId, noteId, snapshot.sequence_num)
    .run()

  const changes = result.meta.changes ?? 0
  const totalBytes = Number(bytes?.total_bytes ?? 0)
  if (changes > 0 && totalBytes > 0) {
    await adjustStorageUsed(db, userId, -totalBytes)
  }

  return changes
}

/**
 * `pruneUpdatesBeforeSnapshot` for a whole batch, in ONE db.batch instead of
 * three round trips per note.
 *
 * The snapshot watermark is passed in rather than re-read: the caller has just
 * written it, and re-reading it per note is exactly the round trip this exists
 * to remove. Every SUM statement is queued ahead of every DELETE, and D1 runs a
 * batch sequentially inside one transaction, so each SUM still observes the rows
 * its DELETE is about to remove.
 */
export const pruneUpdatesBeforeSnapshotBatch = async (
  db: D1Database,
  userId: string,
  vaultId: string,
  notes: Array<{ noteId: string; sequenceNum: number }>
): Promise<number> => {
  if (notes.length === 0) return 0

  const statements: D1PreparedStatement[] = [
    ...notes.map((note) =>
      db.prepare(PRUNE_SUM_SQL).bind(userId, vaultId, note.noteId, note.sequenceNum)
    ),
    ...notes.map((note) =>
      db.prepare(PRUNE_DELETE_SQL).bind(userId, vaultId, note.noteId, note.sequenceNum)
    )
  ]

  const results = await db.batch<{ total_bytes: number }>(statements)

  let changes = 0
  let totalBytes = 0
  for (let i = 0; i < notes.length; i++) {
    const deleted = results[notes.length + i].meta.changes ?? 0
    changes += deleted
    if (deleted > 0) {
      totalBytes += Number((results[i].results ?? [])[0]?.total_bytes ?? 0)
    }
  }

  if (changes > 0 && totalBytes > 0) {
    await adjustStorageUsed(db, userId, -totalBytes)
  }

  return changes
}
