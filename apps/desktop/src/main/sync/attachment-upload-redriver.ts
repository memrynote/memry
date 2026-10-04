import { createLogger } from '../lib/logger'
import { backfillUnsyncedAttachments } from './attachment-backfill'
import { drainAttachmentOutbox, dropUploadsWithoutFile } from './attachment-outbox'
import { getValidAccessToken } from './token-manager'

const log = createLogger('AttachmentUploadRedriver')

const REDRIVE_INTERVAL_MS = 5 * 60 * 1000

let redriveTimer: NodeJS.Timeout | null = null
let isOnline: (() => boolean) | null = null

/**
 * Upload side of the attachment re-drive (#2651), the counterpart of the
 * download re-driver. The sync runtime runs it at start, on every reconnect and
 * every five minutes while it is up.
 *
 * The backfill puts rows in the outbox for files whose save-time emit never
 * fired, and only the drain that follows picks them up, so the two always run
 * together and in this order. The drain uploads each pending row once and
 * keeps failed rows for the next pass. Rows whose file is gone are dropped
 * first, offline or signed out too.
 */
async function redrive(): Promise<void> {
  if (!isOnline) return
  dropUploadsWithoutFile()
  try {
    // Same gate as the body outbox's pause: offline or without a token every
    // upload fails, and each failure would count an attempt against its row.
    if (!isOnline() || !(await getValidAccessToken())) return
    try {
      backfillUnsyncedAttachments()
    } catch (error) {
      // A backfill that cannot run must never keep the drain from retrying the
      // rows already pending.
      log.warn('Attachment backfill skipped', { error })
    }
    await drainAttachmentOutbox()
  } catch (error) {
    log.warn('Attachment upload re-drive failed', { error })
  }
}

function start(online: () => boolean): void {
  stop()
  isOnline = online
  redriveTimer = setInterval(() => void redrive(), REDRIVE_INTERVAL_MS)
  redriveTimer.unref?.()
}

function stop(): void {
  if (redriveTimer) {
    clearInterval(redriveTimer)
    redriveTimer = null
  }
  isOnline = null
}

export const attachmentUploadRedriver = { start, stop, redrive }
