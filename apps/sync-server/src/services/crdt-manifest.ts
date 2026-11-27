import type { CrdtManifestDocument, CrdtManifestResponse } from '@memry/contracts/sync-api'
import { coalesceRevision, type SnapshotRevisionRow } from './crdt-shared'

const SCOPE = 'user_id = ? AND vault_id = ?'

/**
 * The page's keys: the first `limit + 1` document ids above `after` that hold
 * an update row, a snapshot row or a floor above 0. Each arm stops at
 * `limit + 1` keys in index order, so the union holds the first `limit + 1` of
 * all three.
 */
const PAGE_KEYS_SQL = `
  SELECT note_id FROM (SELECT DISTINCT note_id FROM crdt_updates WHERE ${SCOPE} AND note_id > ? ORDER BY note_id LIMIT ?)
  UNION
  SELECT note_id FROM (SELECT note_id FROM crdt_snapshots WHERE ${SCOPE} AND note_id > ? ORDER BY note_id LIMIT ?)
  UNION
  SELECT note_id FROM (SELECT note_id FROM crdt_sequence_floors WHERE ${SCOPE} AND note_id > ? AND floor > 0 ORDER BY note_id LIMIT ?)
  ORDER BY note_id LIMIT ?`

const RANGE = `${SCOPE} AND note_id > ? AND note_id <= ?`
const FLOORS_SQL = `SELECT note_id, floor FROM crdt_sequence_floors WHERE ${RANGE} AND floor > 0`
const SNAPSHOTS_SQL = `SELECT note_id, id, sequence_num, revision, created_at, size_bytes FROM crdt_snapshots WHERE ${RANGE}`
const MAX_SEQUENCE_SQL = `SELECT note_id, MAX(sequence_num) AS max_seq FROM crdt_updates WHERE ${RANGE} GROUP BY note_id`

/**
 * One page of `GET /sync/crdt/manifest` (protocol 07 §7.4.1): per document its
 * floor, its snapshot's revision and sequence number, and its highest stored
 * update, in ascending `note_id` order. No ciphertext.
 *
 * The key read only bounds the page. The documents come from one D1 batch over
 * `(after, last key]`, so a document's floor, snapshot and highest update are
 * one consistent read, and a purge or snapshot write that commits between the
 * two reads shows up whole or not at all.
 */
export const getCrdtManifestPage = async (
  db: D1Database,
  userId: string,
  vaultId: string,
  after: string,
  limit: number
): Promise<CrdtManifestResponse> => {
  const keys = await db
    .prepare(PAGE_KEYS_SQL)
    .bind(
      userId,
      vaultId,
      after,
      limit + 1,
      userId,
      vaultId,
      after,
      limit + 1,
      userId,
      vaultId,
      after,
      limit + 1,
      limit + 1
    )
    .all<{ note_id: string }>()
  const rows = keys.results ?? []
  if (rows.length === 0) return { documents: [], nextCursor: null }

  const hasMore = rows.length > limit
  const last = rows[Math.min(rows.length, limit) - 1].note_id
  const range = [userId, vaultId, after, last]
  const [floors, snapshots, maxSequences] = await db.batch([
    db.prepare(FLOORS_SQL).bind(...range),
    db.prepare(SNAPSHOTS_SQL).bind(...range),
    db.prepare(MAX_SEQUENCE_SQL).bind(...range)
  ])

  const documents = new Map<string, CrdtManifestDocument>()
  const documentOf = (noteId: string): CrdtManifestDocument => {
    let document = documents.get(noteId)
    if (!document) {
      document = { noteId, floor: 0, snapshot: null, maxSequenceNum: 0 }
      documents.set(noteId, document)
    }
    return document
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- D1 rows are untyped; the shape is fixed by FLOORS_SQL
  for (const row of (floors as D1Result<{ note_id: string; floor: number }>).results ?? []) {
    documentOf(row.note_id).floor = row.floor
  }
  type SnapshotRow = SnapshotRevisionRow & { note_id: string; sequence_num: number }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- D1 rows are untyped; the shape is fixed by SNAPSHOTS_SQL
  const snapshotRows = (snapshots as D1Result<SnapshotRow>).results ?? []
  for (const row of snapshotRows) {
    documentOf(row.note_id).snapshot = {
      revision: coalesceRevision(row),
      sequenceNum: row.sequence_num
    }
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- D1 rows are untyped; the shape is fixed by MAX_SEQUENCE_SQL
  for (const row of (maxSequences as D1Result<{ note_id: string; max_seq: number }>).results ??
    []) {
    documentOf(row.note_id).maxSequenceNum = row.max_seq
  }

  return {
    // Ids are ASCII (`NoteIdSchema`), where code-unit order is SQLite's BINARY order.
    documents: [...documents.values()].toSorted((a, b) =>
      a.noteId < b.noteId ? -1 : a.noteId > b.noteId ? 1 : 0
    ),
    nextCursor: hasMore ? last : null
  }
}
