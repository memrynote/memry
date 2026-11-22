import { PACK_REPLACED_GRACE_SECONDS } from '@memry/contracts/sync-api'

import { createLogger } from '../lib/logger'
import type { PackKindName } from './pack-format'
import { ALWAYS, packKeyRange, type Guard, type VaultScope } from './pack-index-write'

const logger = createLogger('PackReplacedObjects')

// Replaced objects one deletion pass removes: one R2 bulk delete takes 1000.
const REPLACED_DELETE_BATCH = 500

/**
 * Delay of the compaction message a body purge enqueues (protocol 08 §8.12):
 * the grace period plus a minute, under PACK_PURGE_DEADLINE_SECONDS = 900. The
 * purge deletes the objects that may hold the body at once, and enqueues this
 * message only when that deletion left some due; its deletion passes retry them.
 */
export const PACK_PURGE_RETRY_DELAY_SECONDS = PACK_REPLACED_GRACE_SECONDS + 60

/** Marker of a recorded object still waiting for its purge rewrite (pack-purge-rewrite.ts). */
export const REWRITE_PENDING = 'rewrite'

const kindPath = (kind: PackKindName): string => `/packs/${kind}/`

/**
 * Statements that drop every listed `kind` pack of the vault while `when`
 * holds, reset the kind's watermark so compaction rebuilds it from source
 * rows, and make every recorded object of the kind due at once, a pending
 * rewrite's included (the rebuild replaces it). `when` is read before the
 * `pack_index` delete, so it may test the rows that delete removes.
 */
export const packKindReset = (
  db: D1Database,
  scope: VaultScope,
  kind: PackKindName,
  when: Guard
): D1PreparedStatement[] => {
  const vault = [scope.userId, scope.vaultId]
  return [
    db
      .prepare(
        `INSERT INTO pack_replaced_objects (pack_key, user_id, vault_id, replaced_by, removed_at)
         SELECT pack_key, user_id, vault_id, 'purge', 0 FROM pack_index
         WHERE user_id = ? AND vault_id = ? AND item_kind = ? AND ${when.sql}
         ON CONFLICT (pack_key) DO UPDATE SET replaced_by = 'purge', removed_at = 0`
      )
      .bind(...vault, kind, ...when.bind),
    db
      .prepare(
        `UPDATE pack_replaced_objects SET removed_at = 0,
           replaced_by = CASE WHEN replaced_by = '${REWRITE_PENDING}' THEN 'purge' ELSE replaced_by END
         WHERE user_id = ? AND vault_id = ? AND instr(pack_key, ?) > 0 AND ${when.sql}
         RETURNING pack_key AS replaced_key`
      )
      .bind(...vault, kindPath(kind), ...when.bind),
    // Reset, not deleted: a build in flight selected under the old watermark,
    // and its compare-and-swap passes when the row is absent, so it would list
    // above the reset range and leave that range unpacked (REVIEW-5283 P6).
    db
      .prepare(
        `INSERT INTO pack_watermarks (user_id, vault_id, item_kind, last_sort_value, last_sort_tiebreak, updated_at, covered_through)
         SELECT ?, ?, ?, 0, '', ?, NULL WHERE ${when.sql}
         ON CONFLICT (user_id, vault_id, item_kind) DO UPDATE SET
           last_sort_value = 0, last_sort_tiebreak = '', covered_through = NULL,
           updated_at = excluded.updated_at`
      )
      .bind(...vault, kind, Math.floor(Date.now() / 1000), ...when.bind),
    db
      .prepare(
        `DELETE FROM pack_index WHERE user_id = ? AND vault_id = ? AND item_kind = ? AND ${when.sql}`
      )
      .bind(...vault, kind, ...when.bind)
  ]
}

/**
 * Statements that re-anchor a `record` chain of cache-only packs (#5230): a
 * watermark written before migration 0023 carries a NULL `covered_through`, so
 * every pack built after it is cache-only and the kind never states coverage
 * (protocol 08 §8.10). While `when` holds, the kind's listed packs leave the
 * listing, their objects wait out the grace period (a reader may hold a URL),
 * and the watermark restarts at 0 with a coverage anchor of 0, so the rebuild
 * tiles from 0. The watermark moves last, so `when` may test it.
 */
export const recordChainReanchor = (
  db: D1Database,
  scope: VaultScope,
  when: Guard
): D1PreparedStatement[] => {
  const vault = [scope.userId, scope.vaultId]
  const now = Math.floor(Date.now() / 1000)
  return [
    db
      .prepare(
        `INSERT INTO pack_replaced_objects (pack_key, user_id, vault_id, replaced_by, removed_at)
         SELECT pack_key, user_id, vault_id, 'reanchor', ? FROM pack_index
         WHERE user_id = ? AND vault_id = ? AND item_kind = 'record' AND ${when.sql}
         ON CONFLICT (pack_key) DO NOTHING`
      )
      .bind(now, ...vault, ...when.bind),
    db
      .prepare(
        `DELETE FROM pack_index WHERE user_id = ? AND vault_id = ? AND item_kind = 'record' AND ${when.sql}`
      )
      .bind(...vault, ...when.bind),
    db
      .prepare(
        `UPDATE pack_watermarks SET last_sort_value = 0, last_sort_tiebreak = '', covered_through = 0,
           updated_at = ?
         WHERE user_id = ? AND vault_id = ? AND item_kind = 'record' AND covered_through IS NULL
           AND ${when.sql}`
      )
      .bind(now, ...vault, ...when.bind)
  ]
}

/**
 * Delete replaced pack objects whose grace period has passed (protocol 08
 * §8.12), oldest first. An object some row still lists is never deleted (the
 * one object-delete rule); its stale record is dropped. A failed R2 delete
 * keeps the records, so the next pass retries. `pending` is true when due
 * records remain: the delete failed or the batch was full.
 */
export const deleteReplacedPackObjects = async (
  db: D1Database,
  storage: R2Bucket,
  scope?: VaultScope
): Promise<{ deleted: number; pending: boolean }> => {
  const due = Math.floor(Date.now() / 1000) - PACK_REPLACED_GRACE_SECONDS
  const where = scope ? 'AND r.user_id = ? AND r.vault_id = ?' : ''
  const vault = scope ? [scope.userId, scope.vaultId] : []
  // Before the select below, so the objects a reset makes due are in it.
  const unrewritten = await db
    .prepare(
      `SELECT r.pack_key, r.user_id, r.vault_id FROM pack_replaced_objects r
       WHERE r.removed_at <= ? AND r.replaced_by = '${REWRITE_PENDING}' ${where}`
    )
    .bind(due, ...vault)
    .all<{ pack_key: string; user_id: string; vault_id: string }>()
  await resetUnrewritten(db, unrewritten.results ?? [])
  const rows = await db
    .prepare(
      `SELECT r.pack_key, r.user_id, r.vault_id, EXISTS (SELECT 1 FROM pack_index p
           WHERE p.user_id = r.user_id AND p.vault_id = r.vault_id AND p.pack_key = r.pack_key) AS listed
       FROM pack_replaced_objects r
       WHERE r.removed_at <= ? ${where}
       ORDER BY r.removed_at ASC
       LIMIT ?`
    )
    .bind(due, ...vault, REPLACED_DELETE_BATCH)
    .all<{ pack_key: string; user_id: string; vault_id: string; listed: number }>()
  const found = rows.results ?? []
  if (found.length === 0) return { deleted: 0, pending: false }
  const unlisted = found.filter((row) => !row.listed)
  // Read again right before the delete (#5247 C19.2): a listing batch that
  // lost its response may commit after the select above, and its object must
  // stay. A key listed now is kept and handled as a stale record below. The
  // read joins pack_index from the selected keys, not from their records: a
  // concurrent pass may already have dropped the record of a relisted key
  // (VERIFY-5449).
  const relisted =
    unlisted.length === 0
      ? new Set<string>()
      : new Set(
          (
            await db
              .prepare(
                `SELECT j.value->>'$[2]' AS pack_key FROM json_each(?) j
                 WHERE EXISTS (SELECT 1 FROM pack_index p WHERE p.user_id = j.value->>'$[0]'
                   AND p.vault_id = j.value->>'$[1]' AND p.pack_key = j.value->>'$[2]')`
              )
              .bind(
                JSON.stringify(unlisted.map((row) => [row.user_id, row.vault_id, row.pack_key]))
              )
              .all<{ pack_key: string }>()
          ).results?.map((row) => row.pack_key)
        )
  const doomed = unlisted.map((row) => row.pack_key).filter((key) => !relisted.has(key))
  try {
    if (doomed.length > 0) await storage.delete(doomed)
  } catch (error) {
    logger.error('replaced pack objects not deleted; retried next pass', {
      objects: doomed.length,
      error: error instanceof Error ? error.message : String(error)
    })
    return { deleted: 0, pending: true }
  }
  // A record found listed is dropped only while its pack is still listed: a
  // reset or purge since the select made it the record of a due object.
  const stale = found
    .filter((row) => row.listed || relisted.has(row.pack_key))
    .map((row) => row.pack_key)
  await db
    .prepare(
      `DELETE FROM pack_replaced_objects WHERE pack_key IN (SELECT value FROM json_each(?))
         OR (pack_key IN (SELECT value FROM json_each(?))
           AND EXISTS (SELECT 1 FROM pack_index p WHERE p.pack_key = pack_replaced_objects.pack_key))`
    )
    .bind(JSON.stringify(doomed), JSON.stringify(stale))
    .run()
  if (doomed.length > 0) logger.info('replaced pack objects deleted', { count: doomed.length })
  return { deleted: doomed.length, pending: found.length === REPLACED_DELETE_BATCH }
}

/**
 * A purge rewrite still pending past its grace (protocol 08 §8.13): the object
 * goes now, so its range is rebuilt from source rows instead. Resets the kind
 * of each such object (packKindReset), which also makes the kind's listed
 * packs due, so the pass that called it deletes them.
 */
const resetUnrewritten = async (
  db: D1Database,
  rows: ReadonlyArray<{ pack_key: string; user_id: string; vault_id: string }>
): Promise<void> => {
  const kinds = new Map<string, { scope: VaultScope; kind: PackKindName }>()
  for (const row of rows) {
    const range = packKeyRange(row.pack_key)
    if (!range) continue
    const scope = { userId: row.user_id, vaultId: row.vault_id }
    kinds.set(`${row.user_id}\u0000${row.vault_id}\u0000${range.kind}`, { scope, kind: range.kind })
  }
  for (const { scope, kind } of kinds.values()) {
    logger.error('purge rewrite still pending past its grace; the kind is dropped and rebuilt', {
      userId: scope.userId,
      vaultId: scope.vaultId,
      kind
    })
    await db.batch(packKindReset(db, scope, kind, ALWAYS))
  }
}

/**
 * Records the object `packId` was written under, due at once, unless its
 * `pack_index` row exists after the batch (#5229). Runs at the end of the batch
 * that tried to list it, so an object no row will ever list is deleted by the
 * next deletion pass even when the delete below fails. It was never listed,
 * so no reader holds a URL to it and it waits for no grace period.
 */
export const recordUnlisted = (
  db: D1Database,
  scope: VaultScope,
  packId: string,
  packKey: string
): D1PreparedStatement =>
  db
    .prepare(
      `INSERT INTO pack_replaced_objects (pack_key, user_id, vault_id, replaced_by, removed_at)
       SELECT ?, ?, ?, 'unlisted', 0 WHERE NOT EXISTS (SELECT 1 FROM pack_index WHERE id = ?)
       ON CONFLICT (pack_key) DO NOTHING`
    )
    .bind(packKey, scope.userId, scope.vaultId, packId)

/**
 * Runs the D1 batch that tries to list `written` (null: the batch wrote no
 * object). When the batch throws, the object is recorded as unlisted, best
 * effort, and the batch error is rethrown. The object is not deleted here: a
 * batch can commit and still lose its response (REVIEW-5277 P3), and its
 * commit can land after any read this catch makes. The deletion pass deletes
 * it later, only while no row lists its key.
 */
export const listingBatch = async <T>(
  db: D1Database,
  scope: VaultScope,
  written: { packId: string; packKey: string } | null,
  statements: D1PreparedStatement[]
): Promise<D1Result<T>[]> => {
  try {
    return await db.batch<T>(statements)
  } catch (error) {
    if (written) {
      try {
        await recordUnlisted(db, scope, written.packId, written.packKey).run()
      } catch (cleanup) {
        logger.error(
          'pack object of a failed listing batch not recorded; left to the orphan sweep',
          {
            error: cleanup instanceof Error ? cleanup.message : String(cleanup)
          }
        )
      }
    }
    throw error
  }
}

/** Deletes an object recordUnlisted recorded; a failure leaves it to the deletion pass. */
export const deleteUnlisted = async (storage: R2Bucket, packKey: string): Promise<void> => {
  try {
    await storage.delete(packKey)
  } catch (error) {
    logger.warn('unlisted pack object not deleted; the replaced-object pass retries it', {
      error: error instanceof Error ? error.message : String(error)
    })
  }
}
