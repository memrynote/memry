import { adjustStorageUsed } from './quota'
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
export const refundReservation = async (
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

export interface SnapshotRevisionRow {
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
export const coalesceRevision = (row: SnapshotRevisionRow): string =>
  row.revision !== '' ? row.revision : `legacy:${row.id}:${row.created_at}:${row.size_bytes}`

/**
 * D1 rejects any single query carrying more than 100 bound parameters, and the
 * rejection is a 500 on the whole request, not a partial result. Mirrors the
 * constant in `services/sync.ts`; the margin under 100 is deliberate.
 */
export const D1_MAX_BIND_PARAMS = 95
