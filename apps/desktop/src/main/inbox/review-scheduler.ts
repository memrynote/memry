/**
 * Inbox Review Scheduler
 *
 * Fires an optional daily desktop notification nudging the user to process
 * the inbox, at a user-set local time, when there are reviewable items.
 *
 * @module main/inbox/review-scheduler
 */

import { powerMonitor } from 'electron'
import { getStatus } from '../vault'
import { getDatabase } from '../database'
import { getSetting, setSetting } from '../database/queries/settings'
import { getInboxReviewSettings } from '../ipc/settings-handlers'
import { countReviewableInboxItems } from './stats'
import { showReviewNotification } from './review-notification'
import { InboxChannels } from '@memry/contracts/inbox-channels'
import { REVIEW_REMINDER_TIME_PATTERN } from '@memry/contracts/settings-schemas'
import { createLogger } from '../lib/logger'
import { registerMinuteTick, unregisterMinuteTick, hasMinuteTick } from '../lib/minute-tick'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import { INBOX_REVIEW_LAST_NOTIFIED_KEY } from './review-reminder-constants'

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
  const m = REVIEW_REMINDER_TIME_PATTERN.exec(target)
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

const logger = createLogger('InboxReview')

/** Id for this poller's subscription to the shared minute tick. */
const MINUTE_TICK_ID = 'inbox-review'

let resumeHandler: (() => void) | null = null
let lastFire: { date: string; count: number } | null = null

function readLastNotifiedDate(): string | null {
  try {
    return getSetting(getDatabase(), INBOX_REVIEW_LAST_NOTIFIED_KEY)
  } catch {
    return null
  }
}

function writeLastNotifiedDate(date: string): boolean {
  try {
    setSetting(getDatabase(), INBOX_REVIEW_LAST_NOTIFIED_KEY, date)
    return true
  } catch (err) {
    logger.warn('Failed to persist last-notified date:', err)
    return false
  }
}

function emitReviewDue(count: number): void {
  broadcastToAllWindows(InboxChannels.events.REVIEW_DUE, { count })
}

/** Run one scheduler tick. Exposed for the interval, startup, resume, and E2E. */
export function runReviewTick(now: Date = new Date()): { notified: boolean; count: number } {
  if (!getStatus().isOpen) return { notified: false, count: 0 }

  const settings = getInboxReviewSettings()
  // Skip the reviewable-count query entirely when the reminder is off (the
  // default), so a disabled install does no inbox work on the 60s tick.
  if (!settings.reviewReminderEnabled) return { notified: false, count: 0 }

  const inboxCount = countReviewableInboxItems()

  const decision = decideReviewNotification({
    enabled: settings.reviewReminderEnabled,
    target: settings.reviewReminderTime,
    now,
    lastNotifiedDate: readLastNotifiedDate(),
    inboxCount
  })

  if (!decision.notify || decision.nextLastNotifiedDate === null) {
    return { notified: false, count: inboxCount }
  }

  // Persist the once-per-day guard BEFORE surfacing the nudge. If the write
  // fails, skip this tick instead of firing: otherwise the guard would stay
  // unset and the notification would re-fire on every 60s tick for the rest of
  // the day. The next tick retries once the DB is writable again.
  if (!writeLastNotifiedDate(decision.nextLastNotifiedDate)) {
    return { notified: false, count: inboxCount }
  }

  lastFire = { date: decision.nextLastNotifiedDate, count: inboxCount }
  showReviewNotification(inboxCount)
  emitReviewDue(inboxCount)
  logger.info(`Review nudge fired for ${inboxCount} item(s)`)
  return { notified: true, count: inboxCount }
}

function safeTick(): void {
  try {
    runReviewTick()
  } catch (err) {
    logger.error('Review tick failed:', err)
  }
}

export function startInboxReviewScheduler(): void {
  if (hasMinuteTick(MINUTE_TICK_ID)) {
    logger.warn('Review scheduler already running')
    return
  }
  safeTick() // startup catch-up
  registerMinuteTick(MINUTE_TICK_ID, safeTick)
  resumeHandler = () => safeTick()
  powerMonitor.on('resume', resumeHandler)
}

export function stopInboxReviewScheduler(): void {
  unregisterMinuteTick(MINUTE_TICK_ID)
  if (resumeHandler) {
    powerMonitor.removeListener('resume', resumeHandler)
    resumeHandler = null
  }
}

export function isReviewSchedulerRunning(): boolean {
  return hasMinuteTick(MINUTE_TICK_ID)
}

export function getLastReviewFireForTest(): { date: string; count: number } | null {
  return lastFire
}
