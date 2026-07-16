/**
 * Inbox Review Scheduler
 *
 * Fires an optional daily desktop notification nudging the user to process
 * the inbox, at a user-set local time, when there are reviewable items.
 *
 * @module main/inbox/review-scheduler
 */

export interface ReviewDecisionInput {
  enabled: boolean
  target: string
  now: Date
  lastNotifiedDate: string | null
  inboxCount: number
}

export interface ReviewDecision {
  notify: boolean
  nextLastNotifiedDate: string | null
}

/** Local calendar day as YYYY-MM-DD (NOT UTC). */
export function localDateString(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Parse "HH:MM" (24h) to minutes-of-day, or null if malformed. */
export function parseTargetMinutes(target: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(target)
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

/**
 * Pure decision: should the review notification fire on this tick?
 * Idempotent via the local-day guard, so interval + resume ticks can't double-fire.
 */
export function decideReviewNotification(input: ReviewDecisionInput): ReviewDecision {
  const { enabled, target, now, lastNotifiedDate, inboxCount } = input
  const noFire: ReviewDecision = { notify: false, nextLastNotifiedDate: lastNotifiedDate }

  if (!enabled || inboxCount <= 0) return noFire

  const targetMinutes = parseTargetMinutes(target)
  if (targetMinutes === null) return noFire

  const today = localDateString(now)
  if (lastNotifiedDate === today) return noFire

  const nowMinutes = now.getHours() * 60 + now.getMinutes()
  if (nowMinutes < targetMinutes) return noFire

  return { notify: true, nextLastNotifiedDate: today }
}
