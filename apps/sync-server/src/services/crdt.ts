import type { NoteBodyChange } from '@memry/contracts/sync-api'
import { generateCrdtKey, getBlob, putBlob } from './blob'
import type { FeedSourceBuilder } from './change-feed'
import { reserveCursors, type CursorReservation } from './cursor'
import { adjustStorageUsed, reserveStorage } from './quota'
import type { ClientIdentity } from '../lib/client-identity'
import { safeBase64Encode } from '../lib/encoding'
import { AppError, ErrorCodes } from '../lib/errors'
import { createLogger } from '../lib/logger'

const logger = createLogger('CrdtService')

/**
 * Refunds a storage reservation for bytes a write did not store: a failed
 * write, or an update ignored as a duplicate.
 *
 * The refund is itself a D1 write, so during a D1 outage it fails too. It must
 * never replace the error that actually caused the write to fail: that turns a
 * typed, handled error into an unhandled one and hides the real cause.
 */
const refundReservation = async (
  db: D1Database,
  userId: string,
  reservedBytes: number,
  context: { operation: string; vaultId: string; noteId?: string; noteCount?: number }
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

/**
 * D1 rejects any single query carrying more than 100 bound parameters, and the
 * rejection is a 500 on the whole request, not a partial result. Mirrors the
 * constant in `services/sync.ts`; the margin under 100 is deliberate.
 */
const D1_MAX_BIND_PARAMS = 95

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
  const sequences = updates.map((update, position) => {
    const [stored] = writeResults[position * 2 + 1].results as Array<{
      id: string
      sequence_num: number
    }>
    if (stored.id === ids[position]) storedBytes += update.byteLength
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

/**
 * The one snapshot upsert. Shared by the single-note and batch writers so the
 * two can never drift on the DO UPDATE SET list: a column missing from that
 * clause (`revision` above all) is not a compile error, it is a client stuck on
 * a stale body forever. `server_cursor` is in it for the same reason (#2295):
 * a replaced snapshot that kept its old cursor would never reach a reader
 * already past that cursor. Bind the 12 row values, then `cursorBinds`.
 */
const snapshotUpsertSql = (cursors: CursorReservation): string =>
  `INSERT INTO crdt_snapshots (id, user_id, vault_id, note_id, blob_key, sequence_num, size_bytes, signer_device_id, created_at, revision, client_platform, client_version, server_cursor)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${cursors.cursorSql})
         ON CONFLICT (user_id, vault_id, note_id)
         DO UPDATE SET blob_key = excluded.blob_key, sequence_num = excluded.sequence_num, size_bytes = excluded.size_bytes, signer_device_id = excluded.signer_device_id, created_at = excluded.created_at, revision = excluded.revision, client_platform = excluded.client_platform, client_version = excluded.client_version, server_cursor = excluded.server_cursor`

export const storeSnapshot = async (
  db: D1Database,
  storage: R2Bucket,
  userId: string,
  vaultId: string,
  noteId: string,
  signerDeviceId: string,
  snapshotData: ArrayBuffer,
  client: ClientIdentity | null = null
): Promise<{ sequenceNum: number; revision: string }> => {
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

    const cursors = reserveCursors(db, userId, 1)
    await db.batch(
      cursors.batch([
        db
          .prepare(snapshotUpsertSql(cursors))
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
            client?.version ?? null,
            ...cursors.cursorBinds(0)
          )
      ])
    )
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

  // The revision goes back to the pusher (#2187) so it can record the token for
  // the row it just wrote instead of leaving it undefined until the next pull.
  return { sequenceNum, revision }
}

/** One note's snapshot inside a batch push. */
export interface SnapshotBatchInput {
  noteId: string
  snapshotData: ArrayBuffer
}

/**
 * Per-note result of a batch push, one entry per input in request order.
 *
 * Discriminated so a caller cannot read `sequenceNum` off a rejection: the
 * accepted branch always carries the watermark, the rejected branch always
 * carries an ErrorCodes value.
 */
export type SnapshotBatchOutcome =
  | { noteId: string; accepted: true; sequenceNum: number; revision: string }
  | { noteId: string; accepted: false; reason: string }

/**
 * Upper bound on simultaneous R2 writes from one snapshot batch. Same value and
 * same reasoning as `R2_PUSH_PUT_CONCURRENCY` in services/sync.ts: the window
 * keeps a full batch streaming through in short waves instead of holding 50 R2
 * connections open at once, well inside the Workers subrequest budget (≤50
 * puts + ~4 batched D1 round trips + ≤50 broadcast fetches per invocation).
 */
const R2_SNAPSHOT_PUT_CONCURRENCY = 8

interface PreparedSnapshot {
  index: number
  noteId: string
  snapshotData: ArrayBuffer
  blobKey: string
  sequenceNum: number
  revision: string
  deltaBytes: number
  reservedBytes: number
}

/**
 * The batched snapshot writer (#1857).
 *
 * Same invariants as `storeSnapshot`, at 4 D1 round trips for the whole batch
 * instead of 6 per note:
 *
 *   - a FRESH `revision` UUID on every write, insert and conflict alike;
 *   - the watermark rule `existingSnapshot?.sequence_num ?? currentSeq`, so a
 *     note that already has a snapshot keeps its sequence number and later
 *     incrementals stay pullable;
 *   - every putBlob AHEAD of the D1 upsert, so a failed put writes no orphan row;
 *   - reserved bytes refunded when a write fails past the reservation.
 *
 * Error semantics: a per-note failure (R2 put) is that note's outcome and never
 * costs its neighbours. Whole-batch failures behave like the single-note path —
 * the metadata read and the storage reservation throw (quota surfaces as the
 * same typed 413 a single push gives), while a failed commit rejects the whole
 * wave because the upsert batch is all-or-nothing.
 */
export const storeSnapshotBatch = async (
  db: D1Database,
  storage: R2Bucket,
  userId: string,
  vaultId: string,
  signerDeviceId: string,
  snapshots: SnapshotBatchInput[],
  client: ClientIdentity | null = null
): Promise<SnapshotBatchOutcome[]> => {
  if (snapshots.length === 0) return []

  const outcomes = new Array<SnapshotBatchOutcome | undefined>(snapshots.length)
  const rejectWithError = (index: number, error: unknown): void => {
    outcomes[index] = {
      noteId: snapshots[index].noteId,
      accepted: false,
      reason: error instanceof AppError ? error.code : ErrorCodes.INTERNAL_ERROR
    }
  }

  const noteIds = snapshots.map((entry) => entry.noteId)

  // Stage 1: metadata, one db.batch. Both reads are chunked at the D1
  // bind-parameter ceiling the way `pullItems` and `getBatchSnapshotMeta` are —
  // an over-long IN list is a 500 on the whole request, not a partial result.
  // The existing-snapshot chunk carries user_id + vault_id ahead of the ids; the
  // watermark chunk binds that triple TWICE (once per UNION arm), so its chunk
  // is half the size.
  const existingChunkSize = D1_MAX_BIND_PARAMS - 2
  const watermarkChunkSize = Math.floor((D1_MAX_BIND_PARAMS - 4) / 2)

  const existingChunks: string[][] = []
  for (let i = 0; i < noteIds.length; i += existingChunkSize) {
    existingChunks.push(noteIds.slice(i, i + existingChunkSize))
  }
  const watermarkChunks: string[][] = []
  for (let i = 0; i < noteIds.length; i += watermarkChunkSize) {
    watermarkChunks.push(noteIds.slice(i, i + watermarkChunkSize))
  }

  const metaStatements: D1PreparedStatement[] = [
    ...existingChunks.map((chunk) =>
      db
        .prepare(
          `SELECT note_id, sequence_num, size_bytes FROM crdt_snapshots
       WHERE user_id = ? AND vault_id = ? AND note_id IN (${chunk.map(() => '?').join(', ')})`
        )
        .bind(userId, vaultId, ...chunk)
    ),
    // The GROUP BY form of `getMaxSequenceNumber`: one row per note that has any
    // history at all, absent for a note the server has never seen.
    ...watermarkChunks.map((chunk) => {
      const placeholders = chunk.map(() => '?').join(', ')
      return db
        .prepare(
          `SELECT note_id, COALESCE(MAX(sequence_num), 0) as max_seq
       FROM (
         SELECT note_id, sequence_num FROM crdt_updates WHERE user_id = ? AND vault_id = ? AND note_id IN (${placeholders})
         UNION ALL
         SELECT note_id, sequence_num FROM crdt_snapshots WHERE user_id = ? AND vault_id = ? AND note_id IN (${placeholders})
       )
       GROUP BY note_id`
        )
        .bind(userId, vaultId, ...chunk, userId, vaultId, ...chunk)
    })
  ]

  const metaResults = await db.batch(metaStatements)

  const existingByNote = new Map<string, { sequence_num: number; size_bytes: number }>()
  for (const result of metaResults.slice(0, existingChunks.length)) {
    for (const row of (
      result as D1Result<{
        note_id: string
        sequence_num: number
        size_bytes: number
      }>
    ).results ?? []) {
      existingByNote.set(row.note_id, {
        sequence_num: row.sequence_num,
        size_bytes: row.size_bytes
      })
    }
  }

  const watermarkByNote = new Map<string, number>()
  for (const result of metaResults.slice(existingChunks.length)) {
    for (const row of (result as D1Result<{ note_id: string; max_seq: number | null }>).results ??
      []) {
      watermarkByNote.set(row.note_id, row.max_seq ?? 0)
    }
  }

  const prepared: PreparedSnapshot[] = snapshots.map((entry, index) => {
    const existing = existingByNote.get(entry.noteId)
    return {
      index,
      noteId: entry.noteId,
      snapshotData: entry.snapshotData,
      blobKey: generateCrdtKey(userId, entry.noteId, vaultId),
      // Client-uploaded snapshots carry no causal proof that they already
      // contain the server's updates above the prior watermark, so the
      // watermark stays put once a snapshot exists — see storeSnapshot.
      sequenceNum: existing?.sequence_num ?? watermarkByNote.get(entry.noteId) ?? 0,
      // One per note per call, so this push's outcome can carry the token the
      // upsert writes. Still fresh on every write and never reused across calls.
      revision: crypto.randomUUID(),
      deltaBytes: entry.snapshotData.byteLength - (existing?.size_bytes ?? 0),
      reservedBytes: 0
    }
  })

  // Stage 2: ONE reservation for the summed growth. A quota failure is a
  // property of the batch, not of any one note, and throws exactly the typed
  // error the single-note push throws.
  const totalGrowth = prepared.reduce((sum, entry) => sum + Math.max(0, entry.deltaBytes), 0)
  if (totalGrowth > 0) {
    await reserveStorage(db, userId, totalGrowth)
    for (const entry of prepared) {
      entry.reservedBytes = Math.max(0, entry.deltaBytes)
    }
  }

  // Bytes reserved for notes that fail past this point, refunded once at the end
  // rather than one UPDATE per failure.
  let refundBytes = 0

  // Stage 3: R2 puts, bounded concurrency, all of them ahead of the D1 commit so
  // a failed put leaves no row pointing at bytes that are not there.
  for (let i = 0; i < prepared.length; i += R2_SNAPSHOT_PUT_CONCURRENCY) {
    const window = prepared.slice(i, i + R2_SNAPSHOT_PUT_CONCURRENCY)
    await Promise.all(
      window.map(async (entry) => {
        try {
          await putBlob(storage, entry.blobKey, entry.snapshotData, userId)
        } catch (error) {
          refundBytes += entry.reservedBytes
          rejectWithError(entry.index, error)
        }
      })
    )
  }
  let stored = prepared.filter((entry) => outcomes[entry.index] === undefined)

  // Stage 4: upserts and storage shrinks, one transactional db.batch. All or
  // nothing per batch — a row never lands without its shrink adjustment, and a
  // client retries the rejected notes either way.
  if (stored.length > 0) {
    const now = Math.floor(Date.now() / 1000)
    // Cursor positions follow `stored` order; the shrink UPDATEs take none.
    const cursors = reserveCursors(db, userId, stored.length)
    const statements: D1PreparedStatement[] = []
    for (const [position, entry] of stored.entries()) {
      statements.push(
        db
          .prepare(snapshotUpsertSql(cursors))
          .bind(
            crypto.randomUUID(),
            userId,
            vaultId,
            entry.noteId,
            entry.blobKey,
            entry.sequenceNum,
            entry.snapshotData.byteLength,
            signerDeviceId,
            now,
            entry.revision,
            client?.platform ?? null,
            client?.version ?? null,
            ...cursors.cursorBinds(position)
          )
      )
      if (entry.deltaBytes < 0) {
        statements.push(
          db
            .prepare(
              'UPDATE users SET storage_used = MAX(0, storage_used + ?), updated_at = ? WHERE id = ?'
            )
            .bind(entry.deltaBytes, now, userId)
        )
      }
    }

    try {
      await db.batch(cursors.batch(statements))
      for (const entry of stored) {
        outcomes[entry.index] = {
          noteId: entry.noteId,
          accepted: true,
          sequenceNum: entry.sequenceNum,
          revision: entry.revision
        }
      }
    } catch (error) {
      for (const entry of stored) {
        refundBytes += entry.reservedBytes
        rejectWithError(entry.index, error)
      }
      stored = []
    }
  }

  // The refund must never surface as a note outcome: those notes already carry
  // the reason they actually failed for.
  await refundReservation(db, userId, refundBytes, {
    operation: 'storeSnapshotBatch',
    vaultId,
    noteCount: snapshots.length
  })

  return outcomes.map(
    (outcome, index) =>
      outcome ?? {
        noteId: snapshots[index].noteId,
        accepted: false,
        reason: ErrorCodes.INTERNAL_ERROR
      }
  )
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
