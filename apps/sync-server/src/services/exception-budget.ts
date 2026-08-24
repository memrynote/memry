import { createLogger } from '../lib/logger'

const logger = createLogger('ExceptionBudget')

// Hard hourly ceiling on `$exception` forwards per install. A healthy install
// emits a handful per hour; a runaway one (a crash loop, an old client's
// per-mutation tripwire) once produced 45% of the project's entire PostHog
// event volume (#1579). 60/hour still samples a genuine crash storm generously
// while capping the worst case at ~1.4k/day instead of tens of thousands.
export const EXCEPTION_BUDGET_PER_HOUR = 60
export const EXCEPTION_BUDGET_WINDOW_SECONDS = 60 * 60

/**
 * Claims `requested` slots from the install's hourly `$exception` budget and
 * returns how many were granted. Shares the `rate_limits` table (same
 * fixed-window upsert as the middleware) under its own key prefix, so it needs
 * no new migration. Trims only the `$exception` stream: the product event and
 * the PostHog log line for the same failure still forward, so the diagnostic
 * record survives the cap.
 *
 * Fails OPEN: a D1 error grants the full request — a flaky database must cost
 * extra PostHog events, never silently swallow a real crash report.
 */
export const claimExceptionBudget = async (
  db: D1Database,
  installHash: string,
  requested: number
): Promise<number> => {
  if (requested <= 0) return 0
  const key = `telemetry-exc:${installHash}`
  const now = Math.floor(Date.now() / 1000)
  const windowStart = now - EXCEPTION_BUDGET_WINDOW_SECONDS
  try {
    const result = await db.batch([
      db
        .prepare(
          `INSERT INTO rate_limits (key, count, window_start)
           VALUES (?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET
             count = CASE WHEN window_start < ? THEN ? ELSE count + ? END,
             window_start = CASE WHEN window_start < ? THEN ? ELSE window_start END`
        )
        .bind(key, requested, now, windowStart, requested, requested, windowStart, now),
      db.prepare('SELECT count FROM rate_limits WHERE key = ?').bind(key)
    ])
    const row = (result[1] as D1Result).results?.[0] as { count: number } | undefined
    const used = row?.count ?? requested
    // `used` already includes this batch; grant the part of it that still fits.
    const granted = Math.min(requested, Math.max(0, EXCEPTION_BUDGET_PER_HOUR - (used - requested)))
    if (granted < requested) {
      logger.warn('Exception budget exhausted, trimming batch', { requested, granted, used })
    }
    return granted
  } catch (error) {
    logger.warn('Exception budget claim failed, forwarding untrimmed', {
      error: error instanceof Error ? error.message : String(error)
    })
    return requested
  }
}
