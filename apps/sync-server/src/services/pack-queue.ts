import { AppError, ErrorCodes } from '../lib/errors'
import type { PackKindName } from './pack-format'
import type { VaultScope } from './pack-index-write'

/**
 * Producer side of the pack compaction queue (#1839): the message body and the
 * nudge a push, a snapshot write or a body purge sends. Kept apart from the
 * compaction core so a caller the core imports (cleanup.ts) can send one.
 */

/** A backfill message's kind and its place in the chain (pack-backfill.ts, #5278). */
export interface PackBackfillStep {
  kind: PackKindName
  hop: number
}

/** A nudge carries no `backfill`; a nudge never builds `crdt_update` packs. */
export interface PackCompactionMessageBody {
  userId: string
  vaultId: string
  backfill?: PackBackfillStep
}

// Backoff caps for a rate-limited send (#1997). Two short retries, upper-bounded
// at 200ms total: the nudge rides waitUntil after the response is already sent,
// so it may spend a little time, but never enough to matter to the invocation.
export const ENQUEUE_RETRY_DELAYS_MS = [50, 150]

// Queues signals per-queue backpressure as "Too Many Requests". Matched on the
// message because the binding throws a plain Error with no status field.
const isQueueRateLimited = (error: unknown): boolean =>
  error instanceof Error && /too many requests|rate limit(ed)?|\b429\b/i.test(error.message)

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Enqueue a compaction nudge after a successful push/snapshot commit.
 * Best-effort coalescing: one message per request (not per item); Queues
 * delivers at-least-once and the core is fully idempotent, so duplicates are
 * harmless and a lost message only delays packing until the next nudge or
 * the cron backfill. Absent binding (local dev without queues) degrades to a
 * no-op — compaction is an optimization, never a correctness requirement.
 */
export const enqueuePackCompaction = async (
  env: { PACK_QUEUE?: Queue<PackCompactionMessageBody> },
  scope: VaultScope,
  delaySeconds = 0
): Promise<void> => {
  if (!env.PACK_QUEUE) return
  const body = { userId: scope.userId, vaultId: scope.vaultId }

  for (let attempt = 0; attempt <= ENQUEUE_RETRY_DELAYS_MS.length; attempt++) {
    try {
      if (delaySeconds > 0) await env.PACK_QUEUE.send(body, { delaySeconds })
      else await env.PACK_QUEUE.send(body)
      return
    } catch (error) {
      // Anything that is not backpressure is a real fault: surface it unchanged
      // so it keeps reading as an unhandled defect.
      if (!isQueueRateLimited(error)) throw error
      if (attempt === ENQUEUE_RETRY_DELAYS_MS.length) {
        // Retries exhausted. The intent is NOT lost and needs no pending-row of
        // its own: pack_watermarks already leave this vault's rows above its
        // watermark, so findBacklogVaults picks it up on the 6-hourly backfill
        // cron. Typed 429 so waitUntilCaptured records expected backpressure
        // instead of an unhandled 500.
        throw new AppError(
          ErrorCodes.PACK_ENQUEUE_RATE_LIMITED,
          'Pack compaction enqueue rate-limited; deferred to the backfill cron',
          429
        )
      }
      // Full jitter — isolates that hit the limit together must not retry in
      // lockstep and rebuild the very burst that triggered it.
      await sleep(Math.random() * ENQUEUE_RETRY_DELAYS_MS[attempt])
    }
  }
}
