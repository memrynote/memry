import { TASK_ACTIVITY_RETENTION_DAYS } from '@memry/db-schema/schema/task-activity'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Oldest `created_at` an activity row may have and still be kept, as an ISO-8601
 * UTC string.
 *
 * Deliberately an *age* rule rather than a per-device row count: retention has
 * to be enforced on apply as well as on write, and only an age rule gives every
 * device the same answer. With a row-count rule, a device that pruned row X
 * would keep re-accepting it from a peer that had not yet pruned, and X would
 * resurrect on every pull.
 */
export function taskActivityRetentionCutoff(now: number = Date.now()): string {
  return new Date(now - TASK_ACTIVITY_RETENTION_DAYS * DAY_MS).toISOString()
}

/**
 * Both `created_at` and the cutoff are ISO-8601 UTC with the same shape
 * (`utcNow()` and the column's `strftime('%Y-%m-%dT%H:%M:%fZ')` default agree),
 * so a lexicographic compare is a chronological compare.
 */
export function isBeyondTaskActivityRetention(
  createdAt: string | null | undefined,
  now?: number
): boolean {
  if (!createdAt) return false
  return createdAt < taskActivityRetentionCutoff(now)
}
