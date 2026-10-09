import { deleteBlobs } from './blob'
import { createLogger } from '../lib/logger'

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

// Four statements per document, one db.batch per chunk.
const PURGE_CHUNK = 20

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
 * are deleted. Then every `crdt_snapshot` pack of the vault is dropped and its
 * watermark reset, because a pack is immutable, holds many notes, and an older
 * revision of this note may sit in any pack built before its current row.
 * Compaction rebuilds them without the dead note. Packs are a derived cache, so
 * this costs bootstrap speed until the rebuild, never data.
 *
 * Idempotent: a re-run finds no rows and changes nothing. Object deletes are
 * best-effort; a failure leaves unreachable objects, never a row without its
 * object. Known gap: a compaction run that selected the old snapshot before the
 * delete committed can still write its pack after the drop.
 */
export const purgeDeletedDocumentBodies = async (
  db: D1Database,
  storage: R2Bucket,
  userId: string,
  vaultId: string,
  noteIds: readonly string[]
): Promise<void> => {
  const ids = [...new Set(noteIds)]
  if (ids.length === 0) return

  const now = Math.floor(Date.now() / 1000)
  const snapshotKeys: string[] = []
  for (let i = 0; i < ids.length; i += PURGE_CHUNK) {
    const statements = ids.slice(i, i + PURGE_CHUNK).flatMap((noteId) => {
      const body = [userId, vaultId, noteId]
      const dead = [userId, vaultId, noteId, userId, vaultId, noteId]
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
        db
          .prepare(`DELETE FROM crdt_updates WHERE ${BODY_ROWS} AND ${DEAD}`)
          .bind(...body, ...dead),
        db
          .prepare(`DELETE FROM crdt_snapshots WHERE ${BODY_ROWS} AND ${DEAD} RETURNING blob_key`)
          .bind(...body, ...dead)
      ]
    })
    const results = await db.batch<{ blob_key: string }>(statements)
    for (const result of results) {
      for (const row of result.results ?? []) {
        if (row.blob_key) snapshotKeys.push(row.blob_key)
      }
    }
  }

  if (snapshotKeys.length === 0) {
    return
  }

  const [packs] = await db.batch<{ pack_key: string }>([
    db
      .prepare(
        `DELETE FROM pack_index WHERE user_id = ? AND vault_id = ? AND item_kind = 'crdt_snapshot'
         RETURNING pack_key`
      )
      .bind(userId, vaultId),
    db
      .prepare(
        `DELETE FROM pack_watermarks WHERE user_id = ? AND vault_id = ? AND item_kind = 'crdt_snapshot'`
      )
      .bind(userId, vaultId)
  ])
  const packKeys = (packs.results ?? []).map((row) => row.pack_key)

  try {
    await deleteBlobs(storage, [...snapshotKeys, ...packKeys], userId)
  } catch (error) {
    logger.warn('Deleted document body: object delete failed, objects are unreachable', {
      vaultId,
      objects: snapshotKeys.length + packKeys.length,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}
