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
