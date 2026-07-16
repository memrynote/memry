/**
 * Inbox Review Scheduler
 *
 * Fires an optional daily desktop notification nudging the user to process
 * the inbox, at a user-set local time, when there are reviewable items.
 *
 * @module main/inbox/review-scheduler
 */

import { BrowserWindow, Notification, powerMonitor } from 'electron'
import { getStatus } from '../vault'
import { getDatabase } from '../database'
import { getSetting, setSetting } from '../database/queries/settings'
import { getInboxReviewSettings } from '../ipc/settings-handlers'
import { countReviewableInboxItems } from './stats'
import { getMainI18n } from '../lib/main-i18n'
import { InboxChannels } from '@memry/contracts/inbox-channels'
import { createLogger } from '../lib/logger'

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

const logger = createLogger('InboxReview')
const SCHEDULER_INTERVAL_MS = 60 * 1000
const LAST_NOTIFIED_KEY = 'inbox.reviewLastNotifiedDate'

let schedulerInterval: ReturnType<typeof setInterval> | null = null
let resumeHandler: (() => void) | null = null
let lastFire: { date: string; count: number } | null = null

function readLastNotifiedDate(): string | null {
  try {
    return getSetting(getDatabase(), LAST_NOTIFIED_KEY)
  } catch {
    return null
  }
}

function writeLastNotifiedDate(date: string): void {
  try {
    setSetting(getDatabase(), LAST_NOTIFIED_KEY, date)
  } catch (err) {
    logger.warn('Failed to persist last-notified date:', err)
  }
}

function emitReviewDue(count: number): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(InboxChannels.events.REVIEW_DUE, { count })
  }
}

function showReviewNotification(count: number): void {
  if (!Notification.isSupported()) {
    logger.warn('Desktop notifications not supported')
    return
  }
  const t = getMainI18n().getFixedT(null, 'system')
  try {
    const notification = new Notification({
      title: t('notification.inboxReview.title'),
      body: t('notification.inboxReview.body', { count }),
      silent: false
    })
    notification.on('click', () => {
      const windows = BrowserWindow.getAllWindows()
      if (windows.length > 0) {
        const win = windows[0]
        if (win.isMinimized()) win.restore()
        win.focus()
        win.webContents.send(InboxChannels.events.REVIEW_OPEN, {})
      }
    })
    notification.show()
  } catch (err) {
    logger.error('Failed to show review notification:', err)
  }
}

/** Run one scheduler tick. Exposed for the interval, startup, resume, and E2E. */
export function runReviewTick(now: Date = new Date()): { notified: boolean; count: number } {
  if (!getStatus().isOpen) return { notified: false, count: 0 }

  const settings = getInboxReviewSettings()
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

  showReviewNotification(inboxCount)
  emitReviewDue(inboxCount)
  writeLastNotifiedDate(decision.nextLastNotifiedDate)
  lastFire = { date: decision.nextLastNotifiedDate, count: inboxCount }
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
  if (schedulerInterval) {
    logger.warn('Review scheduler already running')
    return
  }
  safeTick() // startup catch-up
  schedulerInterval = setInterval(safeTick, SCHEDULER_INTERVAL_MS)
  resumeHandler = () => safeTick()
  powerMonitor.on('resume', resumeHandler)
}

export function stopInboxReviewScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval)
    schedulerInterval = null
  }
  if (resumeHandler) {
    powerMonitor.removeListener('resume', resumeHandler)
    resumeHandler = null
  }
}

export function isReviewSchedulerRunning(): boolean {
  return schedulerInterval !== null
}

export function getLastReviewFireForTest(): { date: string; count: number } | null {
  return lastFire
}
