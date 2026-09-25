import { CRDT_SNAPSHOT_NOT_COVERED } from '@memry/contracts/sync-api'
import { deleteBlobs, generateCrdtSnapshotKey, putBlob } from './blob'
import { reserveCursors, type CursorReservation } from './cursor'
import { adjustStorageUsed, reserveStorage } from './quota'
import { D1_MAX_BIND_PARAMS, refundReservation } from './crdt-shared'
import type { ClientIdentity } from '../lib/client-identity'
import { AppError, ErrorCodes } from '../lib/errors'
import { createLogger } from '../lib/logger'

const logger = createLogger('CrdtSnapshotWrite')

/**
 * What a snapshot push claims about the state it carries (#2299, protocol 07
 * §7.7.1). `coversThrough`: every note_body feed row of the note at or below
 * this cursor is merged into the pushed state. `baseRevision`: the revision of
 * the stored snapshot the pusher last merged or pushed.
 */
export interface SnapshotClaim {
  coversThrough: number
  baseRevision?: string
}

/** One note's snapshot inside a batch push. */
export interface SnapshotBatchInput {
  noteId: string
  snapshotData: ArrayBuffer
  claim?: SnapshotClaim
}

/**
 * Per-note result of a batch push, one entry per input in request order.
 *
 * Discriminated so a caller cannot read `sequenceNum` off a rejection: the
 * accepted branch always carries the watermark, the rejected branch always
 * carries an ErrorCodes value. A CRDT_SNAPSHOT_NOT_COVERED rejection also
 * carries the refusing snapshot's cursor.
 */
export type SnapshotBatchOutcome =
  | { noteId: string; accepted: true; sequenceNum: number; revision: string }
  | { noteId: string; accepted: false; reason: string; blockingCursor?: number }

/**
 * The per-note refusal (#2299): the stored snapshot may hold state this push
 * does not, so replacing it could lose rows only that snapshot still carries.
 * `blockingCursor` is the refusing snapshot's feed cursor; a client that has
 * read the feed past it has seen that snapshot.
 */
export class SnapshotNotCoveredError extends AppError {
  readonly blockingCursor: number | null

  constructor(blockingCursor: number | null) {
    super(
      ErrorCodes.CRDT_SNAPSHOT_NOT_COVERED,
      'The stored snapshot holds state this push does not cover',
      409
    )
    this.blockingCursor = blockingCursor
    this.details = blockingCursor === null ? undefined : { blockingCursor }
  }
}

/**
 * Upper bound on simultaneous R2 writes from one snapshot batch. Same value and
 * same reasoning as `R2_PUSH_PUT_CONCURRENCY` in services/sync.ts: the window
 * keeps a full batch streaming through in short waves instead of holding 50 R2
 * connections open at once, well inside the Workers subrequest budget.
 */
const R2_SNAPSHOT_PUT_CONCURRENCY = 8

/**
 * When a stored snapshot may be replaced (#2299, protocol 07 §7.7.1). It is a
 * condition of the upsert itself, never a prior read, so two concurrent pushes
 * cannot both pass it against the same row.
 *
 * - Without a claim (`excluded.covers_through IS NULL`): only a row no claim
 *   ever wrote. A claimed row's watermark was earned by pruning rows only its
 *   blob still holds; an unclaimed push never merged them.
 * - With a claim `C`:
 *   - a legacy row (no cursor, no claim);
 *   - the row the pusher last merged or pushed (`baseRevision`);
 *   - a row the pusher's feed has passed (`server_cursor <= C`), whoever
 *     signed it.
 *
 * Nothing else. A device id is no proof of state: a restored or cloned data
 * dir signs with the same id, and a stale own encode (a retry, a lost
 * response) may lack content its newer snapshot took through `baseRevision`.
 * Such a push gets the ordinary refusal and the client pulls.
 *
 * Bind: `baseRevision` (or null).
 */
const REPLACE_ALLOWED_SQL = `(excluded.covers_through IS NULL AND crdt_snapshots.covers_through IS NULL)
     OR (excluded.covers_through IS NOT NULL AND (
          (crdt_snapshots.server_cursor IS NULL AND crdt_snapshots.covers_through IS NULL)
       OR crdt_snapshots.revision = ?
       OR crdt_snapshots.server_cursor <= excluded.covers_through))`

/**
 * The claim a replaced row keeps. Through the base arm the pusher merged the
 * stored snapshot, so the new blob holds both coverages; storing only `C`
 * would let a later push at `C` replace content that snapshot pruned above
 * it. `old.server_cursor` is not used: rows between the old claim and the old
 * snapshot's cursor are not provably merged.
 *
 * Bind: `baseRevision` (or null).
 */
const STORED_COVERS_THROUGH_SQL = `CASE
     WHEN excluded.covers_through IS NOT NULL AND crdt_snapshots.revision = ?
       THEN MAX(excluded.covers_through, COALESCE(crdt_snapshots.covers_through, 0))
     ELSE excluded.covers_through
   END`

/**
 * The one snapshot upsert. A column missing from the DO UPDATE SET list
 * (`revision` above all) is not a compile error, it is a client stuck on a
 * stale body forever; `server_cursor` is in it so a replaced snapshot reaches
 * readers past its old cursor (#2295). `sequence_num` never moves down
 * (#2299): a concurrent push that read an older watermark must not lower it
 * under rows a claimed push pruned (07 §7.8).
 *
 * Bind the 13 row values, then `cursorBinds`, then `baseRevision` twice (the
 * stored claim, then the guard).
 */
const snapshotUpsertSql = (cursors: CursorReservation): string =>
  `INSERT INTO crdt_snapshots (id, user_id, vault_id, note_id, blob_key, sequence_num, size_bytes, signer_device_id, created_at, revision, client_platform, client_version, covers_through, server_cursor)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${cursors.cursorSql})
         ON CONFLICT (user_id, vault_id, note_id)
         DO UPDATE SET blob_key = excluded.blob_key, sequence_num = MAX(crdt_snapshots.sequence_num, excluded.sequence_num), size_bytes = excluded.size_bytes, signer_device_id = excluded.signer_device_id, created_at = excluded.created_at, revision = excluded.revision, client_platform = excluded.client_platform, client_version = excluded.client_version, covers_through = ${STORED_COVERS_THROUGH_SQL}, server_cursor = excluded.server_cursor
         WHERE ${REPLACE_ALLOWED_SQL}`

/**
 * The watermark a claim may earn: the highest update sequence above the
 * current watermark `w` such that every update from `w` up to it carries a
 * cursor at or below `c`. It stops below the first row with no cursor or a
 * cursor above `c`: a reader that fetched the snapshot resumes above the
 * watermark and would never see a row below it the snapshot does not hold.
 */
const COVERED_WATERMARK_SQL = `SELECT COALESCE(MAX(sequence_num), ?) AS covered FROM crdt_updates
   WHERE user_id = ? AND vault_id = ? AND note_id = ? AND sequence_num > ?
     AND server_cursor IS NOT NULL AND server_cursor <= ?
     AND sequence_num < COALESCE((
       SELECT MIN(sequence_num) FROM crdt_updates
       WHERE user_id = ? AND vault_id = ? AND note_id = ? AND sequence_num > ?
         AND (server_cursor IS NULL OR server_cursor > ?)
     ), 9223372036854775807)`

/**
 * The claimed prune: rows the claim covers, at or below the earned watermark,
 * and only when the upsert in the same batch applied (the row now carries this
 * push's revision). A row with no cursor is never covered.
 */
const COVERED_PRUNE_SCOPE_SQL = `FROM crdt_updates
   WHERE user_id = ? AND vault_id = ? AND note_id = ? AND sequence_num <= ?
     AND server_cursor IS NOT NULL AND server_cursor <= ?
     AND EXISTS (SELECT 1 FROM crdt_snapshots
                 WHERE user_id = ? AND vault_id = ? AND note_id = ? AND revision = ?)`

interface ExistingRow {
  note_id: string
  sequence_num: number
  size_bytes: number
  server_cursor: number | null
  covers_through: number | null
}

interface StoredRow {
  note_id: string
  blob_key: string
  server_cursor: number | null
}

interface PlannedWrite {
  index: number
  noteId: string
  snapshotData: ArrayBuffer
  claim?: SnapshotClaim
  blobKey: string
  sequenceNum: number
  revision: string
  reservedBytes: number
}

type WriteResult =
  { ok: true; sequenceNum: number; revision: string } | { ok: false; error: unknown }

const chunk = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
  return chunks
}

/**
 * Every snapshot write, single and batch (#1857, #2299). Per note:
 *
 *   - a FRESH `revision` on every write, and a per-write R2 key under it, so a
 *     losing concurrent write never clobbers the winner's bytes;
 *   - every R2 put AHEAD of the D1 commit, so a failed put writes no row;
 *   - one D1 batch: the cursor reservation, then per note the previous key, the
 *     conditional upsert, and for a claim its SUM and prune, which only touch
 *     rows once the upsert applied;
 *   - after the commit: the replaced object is deleted (only when its key
 *     differs), a refused write's own object is deleted and its reservation
 *     refunded, and a refused note is answered from a re-read of its row.
 *
 * A per-note failure is that note's result. The metadata read and the storage
 * reservation throw for the whole call; a commit that throws fails every note
 * a re-read cannot show committed.
 */
const writeSnapshots = async (
  db: D1Database,
  storage: R2Bucket,
  userId: string,
  vaultId: string,
  signerDeviceId: string,
  writes: SnapshotBatchInput[],
  client: ClientIdentity | null
): Promise<WriteResult[]> => {
  const results = new Array<WriteResult | undefined>(writes.length)
  const noteIds = writes.map((entry) => entry.noteId)
  const readRows = async (entries: PlannedWrite[]): Promise<Map<string, StoredRow>> => {
    const reread = await db.batch<StoredRow>(
      chunk(entries, D1_MAX_BIND_PARAMS - 2).map((ids) =>
        db
          .prepare(
            `SELECT note_id, blob_key, server_cursor FROM crdt_snapshots
             WHERE user_id = ? AND vault_id = ? AND note_id IN (${ids.map(() => '?').join(', ')})`
          )
          .bind(userId, vaultId, ...ids.map((entry) => entry.noteId))
      )
    )
    return new Map(reread.flatMap((r) => r.results ?? []).map((row) => [row.note_id, row]))
  }

  // Stage 1: metadata. The watermark chunk binds the triple twice (one per
  // UNION arm), so it is half the size of the existing-row chunk.
  const existingChunks = chunk(noteIds, D1_MAX_BIND_PARAMS - 2)
  const watermarkChunks = chunk(noteIds, Math.floor((D1_MAX_BIND_PARAMS - 4) / 2))
  const metaResults = await db.batch([
    ...existingChunks.map((ids) =>
      db
        .prepare(
          `SELECT note_id, sequence_num, size_bytes, server_cursor, covers_through FROM crdt_snapshots
           WHERE user_id = ? AND vault_id = ? AND note_id IN (${ids.map(() => '?').join(', ')})`
        )
        .bind(userId, vaultId, ...ids)
    ),
    ...watermarkChunks.map((ids) => {
      const placeholders = ids.map(() => '?').join(', ')
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
        .bind(userId, vaultId, ...ids, userId, vaultId, ...ids)
    })
  ])
  const existingByNote = new Map<string, ExistingRow>()
  for (const result of metaResults.slice(0, existingChunks.length)) {
    for (const row of (result as D1Result<ExistingRow>).results ?? []) {
      existingByNote.set(row.note_id, row)
    }
  }
  const maxSeqByNote = new Map<string, number>()
  for (const result of metaResults.slice(existingChunks.length)) {
    for (const row of (result as D1Result<{ note_id: string; max_seq: number | null }>).results ??
      []) {
      maxSeqByNote.set(row.note_id, row.max_seq ?? 0)
    }
  }

  // The covered watermark of every claimed write, one more round trip.
  const claimed = writes.flatMap((entry, index) =>
    entry.claim ? [{ index, watermark: existingByNote.get(entry.noteId)?.sequence_num ?? 0 }] : []
  )
  const coveredByIndex = new Map<number, number>()
  if (claimed.length > 0) {
    const covered = await db.batch<{ covered: number }>(
      claimed.map(({ index, watermark }) => {
        const { noteId, claim } = writes[index]
        const c = (claim as SnapshotClaim).coversThrough
        return db
          .prepare(COVERED_WATERMARK_SQL)
          .bind(
            watermark,
            userId,
            vaultId,
            noteId,
            watermark,
            c,
            userId,
            vaultId,
            noteId,
            watermark,
            c
          )
      })
    )
    claimed.forEach(({ index, watermark }, position) => {
      const value = (covered[position]?.results ?? [])[0]?.covered ?? watermark
      coveredByIndex.set(index, Math.max(watermark, value))
    })
  }

  // An unclaimed push onto a claimed row is refused from the stage-1 read,
  // before its R2 put: a pre-#2299 client retries every refusal, so each retry
  // costs a D1 read only. The upsert's guard stays the authority.
  const planned: PlannedWrite[] = writes.flatMap((entry, index) => {
    const existing = existingByNote.get(entry.noteId)
    if (!entry.claim && existing && existing.covers_through !== null) {
      results[index] = { ok: false, error: new SnapshotNotCoveredError(existing.server_cursor) }
      return []
    }
    const revision = crypto.randomUUID()
    const write: PlannedWrite = {
      index,
      noteId: entry.noteId,
      snapshotData: entry.snapshotData,
      claim: entry.claim,
      blobKey: generateCrdtSnapshotKey(userId, entry.noteId, vaultId, revision),
      // Without a claim, client snapshots carry no causal proof that they
      // contain the server's updates above the prior watermark, so it stays put
      // once a snapshot exists (§7.6). A claim earns its covered watermark.
      sequenceNum: entry.claim
        ? (coveredByIndex.get(index) ?? 0)
        : (existing?.sequence_num ?? maxSeqByNote.get(entry.noteId) ?? 0),
      // Fresh on EVERY write and never conditional on the bytes: a revision
      // that fails to move when the blob does leaves a client skipping a
      // snapshot it needed, with a stale body forever.
      revision,
      reservedBytes: Math.max(0, entry.snapshotData.byteLength - (existing?.size_bytes ?? 0))
    }
    return [write]
  })

  // Stage 2: one reservation for the summed growth; quota is a property of
  // the call and throws the typed 413 a single push gives.
  const totalReserved = planned.reduce((sum, entry) => sum + entry.reservedBytes, 0)
  if (totalReserved > 0) await reserveStorage(db, userId, totalReserved)

  let refundBytes = 0
  const orphanKeys: string[] = []

  // Stage 3: R2 puts to per-write keys, bounded concurrency, ahead of the commit.
  for (const window of chunk(planned, R2_SNAPSHOT_PUT_CONCURRENCY)) {
    await Promise.all(
      window.map(async (entry) => {
        try {
          await putBlob(storage, entry.blobKey, entry.snapshotData, userId)
        } catch (error) {
          refundBytes += entry.reservedBytes
          results[entry.index] = { ok: false, error }
        }
      })
    )
  }
  const stored = planned.filter((entry) => results[entry.index] === undefined)

  // Stage 4: one transactional batch. Per note: previous key, upsert, and for a
  // claim the SUM and DELETE, all conditioned on the upsert having applied.
  let storageDelta = 0
  const refused: PlannedWrite[] = []
  if (stored.length > 0) {
    const now = Math.floor(Date.now() / 1000)
    const cursors = reserveCursors(db, userId, stored.length)
    const statements: D1PreparedStatement[] = []
    const layout: Array<{ previous: number; upsert: number; sum?: number; prune?: number }> = []
    for (const [position, entry] of stored.entries()) {
      const slot: (typeof layout)[number] = { previous: statements.length, upsert: 0 }
      statements.push(
        db
          .prepare(
            'SELECT blob_key, size_bytes FROM crdt_snapshots WHERE user_id = ? AND vault_id = ? AND note_id = ?'
          )
          .bind(userId, vaultId, entry.noteId)
      )
      slot.upsert = statements.length
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
            entry.claim?.coversThrough ?? null,
            ...cursors.cursorBinds(position),
            entry.claim?.baseRevision ?? null,
            entry.claim?.baseRevision ?? null
          )
      )
      if (entry.claim) {
        const binds = [
          userId,
          vaultId,
          entry.noteId,
          entry.sequenceNum,
          entry.claim.coversThrough,
          userId,
          vaultId,
          entry.noteId,
          entry.revision
        ]
        slot.sum = statements.length
        statements.push(
          db
            .prepare(
              `SELECT COALESCE(SUM(length(update_data)), 0) AS total_bytes ${COVERED_PRUNE_SCOPE_SQL}`
            )
            .bind(...binds)
        )
        slot.prune = statements.length
        statements.push(db.prepare(`DELETE ${COVERED_PRUNE_SCOPE_SQL}`).bind(...binds))
      }
      layout.push(slot)
    }

    try {
      const batch = await db.batch(cursors.batch(statements))
      // The reservation's two statements come first.
      const at = (i: number): D1Result => batch[i + 2]
      for (const [position, entry] of stored.entries()) {
        const slot = layout[position]
        const applied = (at(slot.upsert).meta.changes ?? 0) > 0
        if (!applied) {
          refused.push(entry)
          refundBytes += entry.reservedBytes
          orphanKeys.push(entry.blobKey)
          continue
        }
        const previous = (
          (at(slot.previous).results ?? []) as Array<{ blob_key: string; size_bytes: number }>
        )[0]
        if (previous && previous.blob_key !== entry.blobKey) orphanKeys.push(previous.blob_key)
        storageDelta +=
          entry.snapshotData.byteLength - (previous?.size_bytes ?? 0) - entry.reservedBytes
        if (slot.sum !== undefined && slot.prune !== undefined) {
          const pruned = at(slot.prune).meta.changes ?? 0
          const bytes = Number(
            ((at(slot.sum).results ?? []) as Array<{ total_bytes: number }>)[0]?.total_bytes ?? 0
          )
          if (pruned > 0) storageDelta -= bytes
        }
        results[entry.index] = {
          ok: true,
          sequenceNum: entry.sequenceNum,
          revision: entry.revision
        }
      }
    } catch (error) {
      // D1 can throw after the transaction committed (a lost connection, an
      // isolate reset), so the outcome is unknown. A row naming this write's
      // key committed: its object stays, the note is answered, and the
      // replaced object is left an orphan because its key is unknown. Only a
      // provably uncommitted write loses its object; with no re-read, nothing
      // is deleted.
      const rows = await readRows(stored).catch((rereadError: unknown) => {
        logger.warn('snapshot commit outcome unknown', {
          vaultId,
          noteCount: stored.length,
          error: rereadError instanceof Error ? rereadError.message : String(rereadError)
        })
        return null
      })
      for (const entry of stored) {
        if (rows?.get(entry.noteId)?.blob_key === entry.blobKey) {
          // The reservation stays spent: the replaced size and the pruned
          // bytes of an ambiguous commit are unknown.
          results[entry.index] = {
            ok: true,
            sequenceNum: entry.sequenceNum,
            revision: entry.revision
          }
          continue
        }
        refundBytes += entry.reservedBytes
        if (rows !== null) orphanKeys.push(entry.blobKey)
        results[entry.index] = { ok: false, error }
      }
    }
  }

  // Stage 5: answer the refused notes with the refusing row's cursor. The
  // refusal wrote nothing, so reading after it is not a race.
  if (refused.length > 0) {
    const rows = await readRows(refused)
    for (const entry of refused) {
      results[entry.index] = {
        ok: false,
        error: new SnapshotNotCoveredError(rows.get(entry.noteId)?.server_cursor ?? null)
      }
    }
  }

  if (storageDelta !== 0) {
    await adjustStorageUsed(db, userId, storageDelta).catch((error: unknown) =>
      logger.error('snapshot storage adjustment failed', {
        vaultId,
        storageDelta,
        error: error instanceof Error ? error.message : String(error)
      })
    )
  }
  await refundReservation(db, userId, refundBytes, {
    operation: 'storeSnapshot',
    vaultId,
    noteCount: writes.length
  })
  // Replaced and refused objects go only after the commit that made them
  // unreachable; a failure leaves an orphan, never a row without bytes.
  await deleteBlobs(storage, orphanKeys, userId).catch((error: unknown) =>
    logger.warn('snapshot object cleanup failed', {
      vaultId,
      count: orphanKeys.length,
      error: error instanceof Error ? error.message : String(error)
    })
  )

  return results.map(
    (result) => result ?? { ok: false, error: new AppError(ErrorCodes.INTERNAL_ERROR, 'lost', 500) }
  )
}

/**
 * One note's snapshot. Throws a typed AppError for anything the batch would
 * report per note: an R2 failure, a failed commit, or the #2299 refusal
 * (`SnapshotNotCoveredError`, 409).
 */
export const storeSnapshot = async (
  db: D1Database,
  storage: R2Bucket,
  userId: string,
  vaultId: string,
  noteId: string,
  signerDeviceId: string,
  snapshotData: ArrayBuffer,
  client: ClientIdentity | null = null,
  claim?: SnapshotClaim
): Promise<{ sequenceNum: number; revision: string }> => {
  const [result] = await writeSnapshots(
    db,
    storage,
    userId,
    vaultId,
    signerDeviceId,
    [{ noteId, snapshotData, claim }],
    client
  )
  if (!result.ok) throw result.error
  return { sequenceNum: result.sequenceNum, revision: result.revision }
}

/**
 * The batched snapshot writer (#1857): every rule of `storeSnapshot`, at a
 * fixed number of D1 round trips for up to 50 notes, one outcome per input in
 * request order.
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
  const results = await writeSnapshots(
    db,
    storage,
    userId,
    vaultId,
    signerDeviceId,
    snapshots,
    client
  )
  return results.map((result, index): SnapshotBatchOutcome => {
    const noteId = snapshots[index].noteId
    if (result.ok) {
      return { noteId, accepted: true, sequenceNum: result.sequenceNum, revision: result.revision }
    }
    if (result.error instanceof SnapshotNotCoveredError) {
      return {
        noteId,
        accepted: false,
        reason: CRDT_SNAPSHOT_NOT_COVERED,
        ...(result.error.blockingCursor === null
          ? {}
          : { blockingCursor: result.error.blockingCursor })
      }
    }
    return {
      noteId,
      accepted: false,
      reason: result.error instanceof AppError ? result.error.code : ErrorCodes.INTERNAL_ERROR
    }
  })
}
