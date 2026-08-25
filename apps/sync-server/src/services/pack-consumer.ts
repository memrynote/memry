import { z } from 'zod'

import { createLogger } from '../lib/logger'
import { compactVault, type PackCompactionMessageBody } from './pack-compaction'
import type { VaultScope } from './pack-compaction'

const logger = createLogger('PackConsumer')

/**
 * Thin queue-consumer wiring for the pack pipeline (#1839).
 *
 * All real logic lives in the pure-ish core (`pack-compaction.ts`); this
 * module only validates the message shape and maps failures to queue retry
 * semantics. It exists so the core stays unit-testable without any Queues
 * machinery — tests call `handlePackCompactionMessage` directly with a D1/R2
 * harness, never a real `Message`.
 *
 * RETRY SEMANTICS (documented contract):
 * - Message bodies are unversioned `{userId, vaultId}`: there is no version
 *   field to branch on, only the zod shape check below, so any future message
 *   evolution must stay backward-compatible with this parser.
 * - Malformed body (wrong shape) -> ACK. The message can never succeed; a
 *   throw would burn max_retries on a poison message.
 * - Core failure (R2/D1 error) -> THROW. Cloudflare Queues redelivers up to
 *   `max_retries` (wrangler.toml: 3), then DROPS the message. Delivery is
 *   at-least-once and the core is idempotent (deterministic pack key +
 *   range-level unique row), so a redelivery re-runs at most one no-op pass,
 *   and a dropped message only delays packing until the next nudge or the
 *   6-hourly backfill cron re-drives the vault (nothing is lost).
 */

const PackCompactionMessageSchema = z.object({
  userId: z.string().min(1),
  vaultId: z.string().min(1)
})

export const parsePackCompactionBody = (body: unknown): PackCompactionMessageBody | null => {
  const parsed = PackCompactionMessageSchema.safeParse(body)
  return parsed.success ? parsed.data : null
}

/**
 * Process one validated message: run every supported kind once for the vault.
 * Returns per-kind outcomes for logging/tests; throws on infrastructure
 * failure so the platform retries the delivery.
 */
export const handlePackCompactionMessage = async (
  db: D1Database,
  storage: R2Bucket,
  scope: VaultScope
): Promise<void> => {
  await compactVault(db, storage, scope)
}

/** ExportedHandlerQueueHandler body used by src/index.ts. */
export const handlePackQueueMessage = async (
  env: { DB: D1Database; STORAGE: R2Bucket },
  body: unknown
): Promise<void> => {
  const parsed = parsePackCompactionBody(body)
  if (!parsed) {
    logger.warn('discarding malformed pack compaction message', { body })
    return // ack — poison messages must not consume retries
  }
  await handlePackCompactionMessage(env.DB, env.STORAGE, parsed) // throw -> retry
}
