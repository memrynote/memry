import { PACK_REPLACED_GRACE_SECONDS } from '@memry/contracts/sync-api'

import { createLogger } from '../lib/logger'
import type { VaultScope } from './pack-index-write'

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
  const rows = await db
    .prepare(
      `SELECT r.pack_key, EXISTS (SELECT 1 FROM pack_index p
           WHERE p.user_id = r.user_id AND p.vault_id = r.vault_id AND p.pack_key = r.pack_key) AS listed
       FROM pack_replaced_objects r
       WHERE r.removed_at <= ? ${where}
       ORDER BY r.removed_at ASC
       LIMIT ?`
    )
    .bind(due, ...(scope ? [scope.userId, scope.vaultId] : []), REPLACED_DELETE_BATCH)
    .all<{ pack_key: string; listed: number }>()
  const found = rows.results ?? []
  if (found.length === 0) return { deleted: 0, pending: false }
  const doomed = found.filter((row) => !row.listed).map((row) => row.pack_key)
  try {
    if (doomed.length > 0) await storage.delete(doomed)
  } catch (error) {
    logger.error('replaced pack objects not deleted; retried next pass', {
      objects: doomed.length,
      error: error instanceof Error ? error.message : String(error)
    })
    return { deleted: 0, pending: true }
  }
  await db
    .prepare('DELETE FROM pack_replaced_objects WHERE pack_key IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(found.map((row) => row.pack_key)))
    .run()
  if (doomed.length > 0) logger.info('replaced pack objects deleted', { count: doomed.length })
  return { deleted: doomed.length, pending: found.length === REPLACED_DELETE_BATCH }
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
 * effort, and deleted at once only if a separate read finds its row absent: a
 * batch can commit and still lose its response (REVIEW-5277 P3). Then the
 * batch error is rethrown.
 */
export const listingBatch = async <T>(
  db: D1Database,
  storage: R2Bucket,
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
        const row = await db
          .prepare('SELECT 1 AS listed FROM pack_index WHERE id = ?')
          .bind(written.packId)
          .first()
        if (!row) await deleteUnlisted(storage, written.packKey)
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

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * Runs one compaction or backfill message's `work` for a vault between two
 * deletion passes, so a build that throws cannot keep a purged body past its
 * deadline (protocol 08 §8.13): the message may be the purge's delayed retry.
 * Objects still due after the work fail the message, so Queues redelivers it
 * (max_retries 3, no retry delay) inside the purge deadline instead of acking
 * it. Builds the work committed stay committed: a redelivery finds their
 * watermarks moved and lists nothing twice. A work error is logged and kept as
 * the cause, also when the final pass itself throws (VERIFY-5267).
 */
export const withReplacedObjectPasses = async <T>(
  db: D1Database,
  storage: R2Bucket,
  scope: VaultScope,
  message: string,
  work: () => Promise<T>
): Promise<T> => {
  await deleteReplacedPackObjects(db, storage, scope)
  let outcome: { ok: true; value: T } | { ok: false; error: unknown }
  try {
    outcome = { ok: true, value: await work() }
  } catch (error) {
    outcome = { ok: false, error }
  }
  let passFailure: { error: unknown } | null = null
  let pending = true
  try {
    pending = (await deleteReplacedPackObjects(db, storage, scope)).pending
  } catch (error) {
    passFailure = { error }
  }
  if (pending) {
    logger.error(`replaced pack objects still due after the ${message}; redelivered`, {
      userId: scope.userId,
      vaultId: scope.vaultId,
      ...(passFailure ? { passError: errorMessage(passFailure.error) } : {}),
      ...(outcome.ok ? {} : { buildError: errorMessage(outcome.error) })
    })
    const cause = outcome.ok ? passFailure : outcome
    throw new Error('replaced pack objects still due', cause ? { cause: cause.error } : {})
  }
  if (!outcome.ok) throw outcome.error
  return outcome.value
}
