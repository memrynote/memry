import { createLogger } from '../lib/logger'
import type { VaultScope } from './pack-index-write'
import { rewritePurgedPacks } from './pack-purge-rewrite'
import { deleteReplacedPackObjects } from './pack-replaced-objects'

const logger = createLogger('PackMessagePasses')

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * Runs one compaction or backfill message's `work` for a vault after the purge
 * rewrite pass and between two deletion passes, so a build that throws cannot
 * keep a purged body past its deadline (protocol 08 §8.13): the message may be
 * the purge's delayed retry. The rewrites run first because a deletion pass
 * resets the kind of a rewrite still pending past its grace, and a rewrite
 * this message can finish should not cost the kind a rebuild.
 *
 * Objects still due or rewrites still pending after the work fail the message,
 * so Queues redelivers it (max_retries 3, no retry delay) inside the purge
 * deadline instead of acking it. Builds the work committed stay committed: a
 * redelivery finds their watermarks moved and lists nothing twice. A work
 * error is logged and kept as the cause, also when the final pass itself
 * throws (VERIFY-5267).
 */
export const withReplacedObjectPasses = async <T>(
  db: D1Database,
  storage: R2Bucket,
  scope: VaultScope,
  message: string,
  work: () => Promise<T>
): Promise<T> => {
  let rewriteFailure: { error: unknown } | null = null
  let rewritesPending = true
  try {
    rewritesPending = (await rewritePurgedPacks(db, storage, scope)).pending
  } catch (error) {
    rewriteFailure = { error }
  }
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
  if (pending || rewritesPending) {
    logger.error(`replaced pack objects still due after the ${message}; redelivered`, {
      userId: scope.userId,
      vaultId: scope.vaultId,
      ...(rewriteFailure ? { rewriteError: errorMessage(rewriteFailure.error) } : {}),
      ...(passFailure ? { passError: errorMessage(passFailure.error) } : {}),
      ...(outcome.ok ? {} : { buildError: errorMessage(outcome.error) })
    })
    const cause = outcome.ok ? (rewriteFailure ?? passFailure) : outcome
    throw new Error('replaced pack objects still due', cause ? { cause: cause.error } : {})
  }
  if (!outcome.ok) throw outcome.error
  return outcome.value
}
