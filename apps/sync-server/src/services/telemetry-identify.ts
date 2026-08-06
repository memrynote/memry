import { createLogger } from '../lib/logger'

// Once-per-session guard for the PostHog $identify merge. See
// migrations/0003_telemetry_identify_sessions.sql for why this is a D1 table
// and not KV.

const logger = createLogger('TelemetryIdentify')

// Sessions are app-launch scoped, so a day is generous. A session still running
// past the TTL re-identifies once, which is harmless (the merge is idempotent)
// and keeps the table from growing without bound.
export const IDENTIFY_SESSION_TTL_SECONDS = 24 * 60 * 60

/**
 * Atomically claims the right to emit `$identify` for a (session, account)
 * pair. Returns true exactly once per pair per TTL window.
 *
 * Fails OPEN: a D1 error returns true, so a flaky database costs duplicate
 * (idempotent) $identify events rather than silently never linking the
 * anonymous install to its account. In practice D1 being down fails the
 * rate-limit middleware first, so this branch is close to unreachable.
 */
export const claimIdentifySession = async (
  db: D1Database,
  sessionId: string,
  accountHash: string
): Promise<boolean> => {
  const key = `${sessionId}:${accountHash}`
  try {
    const result = await db
      .prepare(
        `INSERT INTO telemetry_identify_sessions (key, created_at)
         VALUES (?, ?)
         ON CONFLICT (key) DO NOTHING`
      )
      .bind(key, Math.floor(Date.now() / 1000))
      .run()
    return (result.meta.changes ?? 0) > 0
  } catch (error) {
    logger.warn('Identify session claim failed, emitting $identify anyway', {
      error: error instanceof Error ? error.message : String(error)
    })
    return true
  }
}
