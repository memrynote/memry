import { deleteBlobs } from './blob'
import { createLogger } from '../lib/logger'
import type { Guard } from './pack-index-write'
import { rewritePurgedPacks } from './pack-purge-rewrite'
import { REWRITE_PENDING, deleteReplacedPackObjects, packKindReset } from './pack-replaced-objects'

const logger = createLogger('DocumentBodyPurge')

/** Record types whose id names a CRDT document (protocol 07 §7.15.2). */
export const DOCUMENT_ITEM_TYPES: ReadonlySet<string> = new Set(['note', 'journal'])

// A document is dead while a note or journal record for its id is deleted and
// none is live. Every statement re-checks it, so a re-create that commits
// between the delete and the purge keeps its body. The snapshot write refuses
// a dead document with it (#5367). Bind: user, vault, note, twice.
export const DEAD = `EXISTS (SELECT 1 FROM sync_items r WHERE r.user_id = ? AND r.vault_id = ?
      AND r.item_type IN ('note', 'journal') AND r.item_id = ? AND r.deleted_at IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM sync_items r WHERE r.user_id = ? AND r.vault_id = ?
      AND r.item_type IN ('note', 'journal') AND r.item_id = ? AND r.deleted_at IS NULL)`

const BODY_ROWS = 'user_id = ? AND vault_id = ? AND note_id = ?'

// Sixteen statements per document, one db.batch per chunk.
const PURGE_CHUNK = 20

const BODY_KINDS = ['crdt_update', 'crdt_snapshot'] as const
type BodyKind = (typeof BODY_KINDS)[number]

/** A listed pack of `kind` written before migration 0024: the documents it holds are unknown. */
const unknownPack = (kind: BodyKind): string =>
  `EXISTS (SELECT 1 FROM pack_index WHERE user_id = ? AND vault_id = ? AND item_kind = '${kind}'
     AND documents IS NULL)`

/** The `pack_index` row holds the document (its `documents`, migration 0024). */
const HOLDS = `documents IS NOT NULL
  AND EXISTS (SELECT 1 FROM json_each(pack_index.documents) WHERE value = ?)`

/**
 * Removes the server body of deleted notes and journals (#2986, protocol 07
 * §7.15): their `crdt_updates` and `crdt_snapshots` rows, the snapshot objects,
 * the bytes they were charged for, and their entries in every listed pack.
 *
 * A deleted id can be re-created (a journal day is always `j<date>`), and a
 * device pulls a re-created document's body from sequence 0. Left in place, the
 * deleted body came back inside the re-created one.
 *
 * Per document, in one transaction: the highest sequence number is kept in
 * `crdt_sequence_floors`, so the re-created body numbers on from it and a device
 * still holding the old cursor does not skip it, with the tombstone's feed
 * cursor, which fences late snapshot pushes (#5367); storage is refunded; the rows
 * are deleted. A pack is immutable and holds many documents, so per body kind
 * (protocol 08 §8.13):
 *
 * - every listed pack whose `documents` names the document leaves the listing
 *   in the same transaction, its object recorded as a pending rewrite
 *   (pack-purge-rewrite.ts). This call then rewrites it without the deleted
 *   entries and deletes the old object. Other packs are untouched.
 * - a kind that still lists a pack written before migration 0024 (`documents`
 *   NULL) is dropped whole and its watermark reset, as every purge did before,
 *   when the document has a row of it (a `crdt_update` pack: any body row,
 *   because a pack built before a snapshot pruned the update rows still holds
 *   them, REVIEW-5260). Its rebuild records `documents`, so the next purge is
 *   scoped.
 * - every replaced object of the kind, which may hold the body, is made due
 *   at once and deleted by the replaced-object pass before this returns.
 *
 * Packs are a derived cache, so a dropped pack costs bootstrap speed until the
 * rebuild, never data.
 *
 * Idempotent: a re-run finds no rows and changes nothing. Snapshot object
 * deletes are best-effort; a failure leaves unreachable objects, never a row
 * without its object. Returns true when pack objects that may hold the body are
 * still due or waiting for their rewrite after this call (a failed R2 delete,
 * a full batch, or more rewrites than one pass): the caller then enqueues the
 * delayed retry message. A compaction run that selected the old body rows
 * before this purge publishes nothing: its pack commit is guarded on those
 * rows (`pack-compaction.ts`).
 */
export const purgeDeletedDocumentBodies = async (
  db: D1Database,
  storage: R2Bucket,
  userId: string,
  vaultId: string,
  noteIds: readonly string[]
): Promise<boolean> => {
  const ids = [...new Set(noteIds)]
  if (ids.length === 0) return false

  const now = Math.floor(Date.now() / 1000)
  const scope = { userId, vaultId }
  const snapshotKeys: string[] = []
  let due = false
  let rewrite = false
  for (let i = 0; i < ids.length; i += PURGE_CHUNK) {
    const statements = ids.slice(i, i + PURGE_CHUNK).flatMap((noteId) => {
      const body = [userId, vaultId, noteId]
      const dead = [userId, vaultId, noteId, userId, vaultId, noteId]
      // The rows a kind's packs may hold, read before the row deletes below.
      const hasRows: Record<BodyKind, Guard> = {
        crdt_update: {
          sql: `(EXISTS (SELECT 1 FROM crdt_updates WHERE ${BODY_ROWS})
            OR EXISTS (SELECT 1 FROM crdt_snapshots WHERE ${BODY_ROWS})) AND ${DEAD}`,
          bind: [...body, ...body, ...dead]
        },
        crdt_snapshot: {
          sql: `EXISTS (SELECT 1 FROM crdt_snapshots WHERE ${BODY_ROWS}) AND ${DEAD}`,
          bind: [...body, ...dead]
        }
      }
      return [
        db
          .prepare(
            // `purge_cursor` is the tombstone's feed cursor (#5367): a claimed
            // snapshot below it never read the delete (crdt-snapshot-write.ts).
            `INSERT INTO crdt_sequence_floors (user_id, vault_id, note_id, floor, purge_cursor)
             SELECT ?, ?, ?, COALESCE(m, 0), t FROM (
               SELECT MAX(sequence_num) AS m FROM (
                 SELECT sequence_num FROM crdt_updates WHERE ${BODY_ROWS}
                 UNION ALL
                 SELECT sequence_num FROM crdt_snapshots WHERE ${BODY_ROWS}
               )
             ), (
               SELECT MAX(server_cursor) AS t FROM sync_items WHERE user_id = ? AND vault_id = ?
                 AND item_type IN ('note', 'journal') AND item_id = ? AND deleted_at IS NOT NULL
             )
             WHERE (m IS NOT NULL OR t IS NOT NULL) AND ${DEAD}
             ON CONFLICT (user_id, vault_id, note_id) DO UPDATE SET floor = MAX(floor, excluded.floor),
               purge_cursor = MAX(COALESCE(purge_cursor, excluded.purge_cursor),
                                  COALESCE(excluded.purge_cursor, purge_cursor))`
          )
          .bind(...body, ...body, ...body, ...body, ...dead),
        db
          .prepare(
            `UPDATE users SET storage_used = MAX(0, storage_used
               - (SELECT COALESCE(SUM(LENGTH(update_data)), 0) FROM crdt_updates WHERE ${BODY_ROWS})
               - (SELECT COALESCE(SUM(size_bytes), 0) FROM crdt_snapshots WHERE ${BODY_ROWS})),
               updated_at = ?
             WHERE id = ? AND ${DEAD}`
          )
          .bind(...body, ...body, now, userId, ...dead),
        ...BODY_KINDS.flatMap((kind) => {
          const has = hasRows[kind]
          const holds = { sql: `${HOLDS} AND ${DEAD}`, bind: [noteId, ...dead] }
          return [
            // Replaced objects of the kind may hold the body: due at once. A
            // pending rewrite waits for its rewrite, which drops the body.
            db
              .prepare(
                `UPDATE pack_replaced_objects SET removed_at = 0
                 WHERE user_id = ? AND vault_id = ? AND instr(pack_key, '/packs/${kind}/') > 0
                   AND replaced_by <> '${REWRITE_PENDING}' AND ${has.sql}
                 RETURNING pack_key AS replaced_key`
              )
              .bind(userId, vaultId, ...has.bind),
            ...packKindReset(db, scope, kind, {
              sql: `${has.sql} AND ${unknownPack(kind)}`,
              bind: [...has.bind, userId, vaultId]
            }),
            db
              .prepare(
                `INSERT INTO pack_replaced_objects (pack_key, user_id, vault_id, replaced_by, removed_at)
                 SELECT pack_key, user_id, vault_id, '${REWRITE_PENDING}', ? FROM pack_index
                 WHERE user_id = ? AND vault_id = ? AND item_kind = '${kind}' AND ${holds.sql}
                 ON CONFLICT (pack_key) DO UPDATE SET replaced_by = excluded.replaced_by,
                   removed_at = excluded.removed_at`
              )
              .bind(now, userId, vaultId, ...holds.bind),
            db
              .prepare(
                `DELETE FROM pack_index WHERE user_id = ? AND vault_id = ? AND item_kind = '${kind}'
                   AND ${holds.sql}
                 RETURNING id AS rewrite_id`
              )
              .bind(userId, vaultId, ...holds.bind)
          ]
        }),
        db
          .prepare(`DELETE FROM crdt_updates WHERE ${BODY_ROWS} AND ${DEAD}`)
          .bind(...body, ...dead),
        db
          .prepare(`DELETE FROM crdt_snapshots WHERE ${BODY_ROWS} AND ${DEAD} RETURNING blob_key`)
          .bind(...body, ...dead)
      ]
    })
    const results = await db.batch<{
      blob_key?: string
      replaced_key?: string
      rewrite_id?: string
    }>(statements)
    for (const result of results) {
      for (const row of result.results ?? []) {
        if (row.blob_key) snapshotKeys.push(row.blob_key)
        if (row.replaced_key) due = true
        if (row.rewrite_id) rewrite = true
      }
    }
  }

  await deleteObjects(storage, userId, vaultId, snapshotKeys)
  if (!due && !rewrite) return false
  // A rewrite makes its old object due; the deletion pass then removes it. What
  // either leaves is retried by the caller's delayed compaction message
  // (PACK_PURGE_RETRY_DELAY_SECONDS), which runs both again.
  const rewrites = rewrite ? await rewritePurgedPacks(db, storage, scope) : { pending: false }
  const deletion = await deleteReplacedPackObjects(db, storage, scope)
  return rewrites.pending || deletion.pending
}

const deleteObjects = async (
  storage: R2Bucket,
  userId: string,
  vaultId: string,
  keys: string[]
): Promise<void> => {
  if (keys.length === 0) return
  try {
    await deleteBlobs(storage, keys, userId)
  } catch (error) {
    logger.warn('Deleted document body: object delete failed, objects are unreachable', {
      vaultId,
      objects: keys.length,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}
