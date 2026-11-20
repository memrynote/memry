import { deleteBlobs } from './blob'
import { createLogger } from '../lib/logger'
import { deleteReplacedPackObjects } from './pack-replaced-objects'

const logger = createLogger('DocumentBodyPurge')

/** Record types whose id names a CRDT document (protocol 07 §7.15.2). */
export const DOCUMENT_ITEM_TYPES: ReadonlySet<string> = new Set(['note', 'journal'])

// A document is dead while a note or journal record for its id is deleted and
// none is live. Every statement re-checks it, so a re-create that commits
// between the delete and the purge keeps its body.
const DEAD = `EXISTS (SELECT 1 FROM sync_items r WHERE r.user_id = ? AND r.vault_id = ?
      AND r.item_type IN ('note', 'journal') AND r.item_id = ? AND r.deleted_at IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM sync_items r WHERE r.user_id = ? AND r.vault_id = ?
      AND r.item_type IN ('note', 'journal') AND r.item_id = ? AND r.deleted_at IS NULL)`

const BODY_ROWS = 'user_id = ? AND vault_id = ? AND note_id = ?'

// Eight statements per document, one db.batch per chunk.
const PURGE_CHUNK = 20

/**
 * Makes the vault's replaced objects of one pack kind due at once (protocol 08
 * §8.12, §8.13). A rollup's replaced inputs may hold the purged body, and the
 * grace period would keep them up to 600 s past the purge, outside the 900 s
 * deadline once a drain is late. The grace only shields a reader of the
 * listing before the rollup, and the purge deletes every listed object of the
 * same kind at once, so that reader already meets 404s and falls back to the
 * item routes.
 */
const replacedDue = (kind: 'crdt_update' | 'crdt_snapshot'): string =>
  `UPDATE pack_replaced_objects SET removed_at = 0
   WHERE user_id = ? AND vault_id = ? AND instr(pack_key, '/packs/${kind}/') > 0`

const RETURNING_REPLACED = 'RETURNING pack_key AS replaced_key'

/**
 * Records the listed packs of one kind that `condition` drops as replaced
 * objects due at once (VERIFY-5267 F3). Runs in the batch before their
 * `pack_index` delete, so the objects are deleted by the replaced-object pass
 * and a failed R2 delete is retried by it, never left as an unrecorded object
 * holding the purged body.
 */
const recordDropped = (kind: 'crdt_update' | 'crdt_snapshot', condition: string): string =>
  `INSERT INTO pack_replaced_objects (pack_key, user_id, vault_id, replaced_by, removed_at)
   SELECT pack_key, user_id, vault_id, 'purge', 0 FROM pack_index
   WHERE user_id = ? AND vault_id = ? AND item_kind = '${kind}' AND ${condition}
   ON CONFLICT (pack_key) DO NOTHING`

/**
 * Removes the server body of deleted notes and journals (#2986, protocol 07
 * §7.15): their `crdt_updates` and `crdt_snapshots` rows, the snapshot objects,
 * and the bytes they were charged for.
 *
 * A deleted id can be re-created (a journal day is always `j<date>`), and a
 * device pulls a re-created document's body from sequence 0. Left in place, the
 * deleted body came back inside the re-created one.
 *
 * Per document, in one transaction: the highest sequence number is kept in
 * `crdt_sequence_floors`, so the re-created body numbers on from it and a device
 * still holding the old cursor does not skip it; storage is refunded; the rows
 * are deleted. A pack is immutable and holds many notes, so the packs that may
 * hold this body are dropped with their kind's watermark reset, and compaction
 * rebuilds them without the dead note. Every `crdt_update` pack of the vault
 * goes in the same transaction as the rows whenever the document has any body
 * row (protocol 08 §8.4.3): a pack left listed would hand a fresh device the
 * deleted updates, and a pack built before a snapshot pruned its update rows
 * still holds them (REVIEW-5260). Every `crdt_snapshot` pack goes after the rows when a
 * snapshot was deleted, because an older revision of this note may sit in any
 * pack built before its current row. Packs are a derived cache, so this costs
 * bootstrap speed until the rebuild, never data. Every dropped pack and every
 * replaced object of its kind is made due in `pack_replaced_objects` and
 * deleted by the replaced-object pass before this returns.
 *
 * Idempotent: a re-run finds no rows and changes nothing. Snapshot object
 * deletes are best-effort; a failure leaves unreachable objects, never a row
 * without its object. Returns true when pack objects that may hold the body are
 * still due after the deletion pass (a failed R2 delete or a full batch): the
 * caller then enqueues the delayed retry message. A compaction run that selected the old body rows before this purge
 * publishes nothing: its pack commit is guarded on those rows
 * (`pack-compaction.ts`).
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
  const snapshotKeys: string[] = []
  let due = false
  for (let i = 0; i < ids.length; i += PURGE_CHUNK) {
    const statements = ids.slice(i, i + PURGE_CHUNK).flatMap((noteId) => {
      const body = [userId, vaultId, noteId]
      const dead = [userId, vaultId, noteId, userId, vaultId, noteId]
      const hasBody = `(EXISTS (SELECT 1 FROM crdt_updates WHERE ${BODY_ROWS})
        OR EXISTS (SELECT 1 FROM crdt_snapshots WHERE ${BODY_ROWS})) AND ${DEAD}`
      return [
        db
          .prepare(
            `INSERT INTO crdt_sequence_floors (user_id, vault_id, note_id, floor)
             SELECT ?, ?, ?, m FROM (
               SELECT MAX(sequence_num) AS m FROM (
                 SELECT sequence_num FROM crdt_updates WHERE ${BODY_ROWS}
                 UNION ALL
                 SELECT sequence_num FROM crdt_snapshots WHERE ${BODY_ROWS}
               )
             )
             WHERE m IS NOT NULL AND ${DEAD}
             ON CONFLICT (user_id, vault_id, note_id) DO UPDATE SET floor = MAX(floor, excluded.floor)`
          )
          .bind(...body, ...body, ...body, ...dead),
        db
          .prepare(
            `UPDATE users SET storage_used = MAX(0, storage_used
               - (SELECT COALESCE(SUM(LENGTH(update_data)), 0) FROM crdt_updates WHERE ${BODY_ROWS})
               - (SELECT COALESCE(SUM(size_bytes), 0) FROM crdt_snapshots WHERE ${BODY_ROWS})),
               updated_at = ?
             WHERE id = ? AND ${DEAD}`
          )
          .bind(...body, ...body, now, userId, ...dead),
        // Before the row delete, which the condition reads.
        db
          .prepare(recordDropped('crdt_update', hasBody))
          .bind(userId, vaultId, ...body, ...body, ...dead),
        db
          .prepare(
            `DELETE FROM pack_index WHERE user_id = ? AND vault_id = ? AND item_kind = 'crdt_update'
               AND ${hasBody}`
          )
          .bind(userId, vaultId, ...body, ...body, ...dead),
        db
          .prepare(`${replacedDue('crdt_update')} AND ${hasBody} ${RETURNING_REPLACED}`)
          .bind(userId, vaultId, ...body, ...body, ...dead),
        db
          .prepare(
            `DELETE FROM pack_watermarks WHERE user_id = ? AND vault_id = ? AND item_kind = 'crdt_update'
               AND ${hasBody}`
          )
          .bind(userId, vaultId, ...body, ...body, ...dead),
        db
          .prepare(`DELETE FROM crdt_updates WHERE ${BODY_ROWS} AND ${DEAD}`)
          .bind(...body, ...dead),
        db
          .prepare(`DELETE FROM crdt_snapshots WHERE ${BODY_ROWS} AND ${DEAD} RETURNING blob_key`)
          .bind(...body, ...dead)
      ]
    })
    const results = await db.batch<{ blob_key?: string; replaced_key?: string }>(statements)
    for (const result of results) {
      for (const row of result.results ?? []) {
        if (row.blob_key) snapshotKeys.push(row.blob_key)
        if (row.replaced_key) due = true
      }
    }
  }

  if (snapshotKeys.length > 0) {
    // The replaced objects are made due in the batch that drops the listing,
    // so a rollup that swapped in between has its inputs caught here, and one
    // that swaps after finds its inputs unlisted and loses.
    const [, , , replaced] = await db.batch<{ replaced_key?: string }>([
      db.prepare(recordDropped('crdt_snapshot', '1')).bind(userId, vaultId),
      db
        .prepare(
          `DELETE FROM pack_index WHERE user_id = ? AND vault_id = ? AND item_kind = 'crdt_snapshot'`
        )
        .bind(userId, vaultId),
      db
        .prepare(
          `DELETE FROM pack_watermarks WHERE user_id = ? AND vault_id = ? AND item_kind = 'crdt_snapshot'`
        )
        .bind(userId, vaultId),
      db.prepare(`${replacedDue('crdt_snapshot')} ${RETURNING_REPLACED}`).bind(userId, vaultId)
    ])
    if ((replaced.results ?? []).length > 0) due = true
  }
  await deleteObjects(storage, userId, vaultId, snapshotKeys)
  if (!due) return false
  // A delete this pass leaves keeps its rows due; the caller's delayed
  // compaction message (PACK_PURGE_RETRY_DELAY_SECONDS) runs the deletion again.
  return (await deleteReplacedPackObjects(db, storage, { userId, vaultId })).pending
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
