/**
 * Inbox Review Notification
 *
 * The native OS desktop notification for the daily inbox review nudge, plus an
 * on-demand test variant fired from Settings so the user can confirm the OS is
 * actually allowed to show it (macOS/Windows/Linux own the permission + DND).
 *
 * Kept separate from the scheduler so both the scheduler and the settings IPC
 * handler can fire it without an import cycle (the scheduler imports
 * settings-handlers for the schedule; settings-handlers imports this).
 *
 * @module main/inbox/review-notification
 */

import { BrowserWindow, Notification } from 'electron'
import { getMainI18n } from '../lib/main-i18n'
import { InboxChannels } from '@memry/contracts/inbox-channels'
import { createLogger } from '../lib/logger'

const logger = createLogger('InboxReview')

/**
 * Focus the app and route it to the inbox — the review notification's click action.
 *
 * Takes the first *live* window rather than `getAllWindows()[0]`: short-lived
 * windows (splash, quick capture, print/export) can still be listed after
 * destruction, and any access to one throws "Object has been destroyed" — which
 * would kill the click handler with nothing focused and nothing navigated.
 */
function openInboxOnClick(): void {
  const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.focus()
  win.webContents.send(InboxChannels.events.REVIEW_OPEN, {})
}

/**
 * Build + show the native review notification. Returns whether the OS actually
 * accepted it: `false` when notifications are unsupported or construction throws
 * (permission denial can't be detected here — the OS silently no-ops it).
 */
function fireReviewNotification(opts: { title: string; body: string }): boolean {
  if (!Notification.isSupported()) {
    logger.warn('Desktop notifications not supported')
    return false
  }
  try {
    const notification = new Notification({ title: opts.title, body: opts.body, silent: false })
    notification.on('click', openInboxOnClick)
    notification.show()
    return true
  } catch (err) {
    logger.error('Failed to show review notification:', err)
    return false
  }
}

/** The real daily nudge, pluralized on the reviewable-item count. */
export function showReviewNotification(count: number): void {
  const t = getMainI18n().getFixedT(null, 'system')
  fireReviewNotification({
    title: t('notification.inboxReview.title'),
    body: t('notification.inboxReview.body', { count })
  })
}

/**
 * Fire the review notification on demand (Settings → "Send test notification").
 * Lets the user verify OS delivery + trigger the first-run permission prompt
 * without waiting for the scheduled time. Reuses the real title so what they see
 * matches the real nudge.
 */
export function sendTestReviewNotification(): { supported: boolean } {
  const t = getMainI18n().getFixedT(null, 'system')
  return {
    supported: fireReviewNotification({
      title: t('notification.inboxReview.title'),
      body: t('notification.inboxReview.testBody')
    })
  }
}
