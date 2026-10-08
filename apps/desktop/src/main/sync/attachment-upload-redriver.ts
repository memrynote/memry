import { createLogger } from '../lib/logger'
import { getCurrentVaultPath } from '../store'
import { backfillUnsyncedAttachments } from './attachment-backfill'
import { isVaultReachable } from '../vault/init'
import { drainAttachmentOutbox, dropUploadsWithoutFile } from './attachment-outbox'
import { getValidAccessToken } from './token-manager'

const log = createLogger('AttachmentUploadRedriver')

const REDRIVE_INTERVAL_MS = 5 * 60 * 1000

let redriveTimer: NodeJS.Timeout | null = null
let isOnline: (() => boolean) | null = null
let generation = 0

/**
 * Upload side of the attachment re-drive (#2651), the counterpart of the
 * download re-driver. The sync runtime runs it at start, on every reconnect and
 * every five minutes while it is up.
 *
 * The backfill puts rows in the outbox for files whose save-time emit never
 * fired, and only the drain that follows picks them up, so the two always run
 * together and in this order. The drain uploads each pending row once and
 * keeps failed rows for the next pass. Rows whose file was deleted are dropped
 * first, offline or signed out too. A vault that is unreachable, such as a
 * removable drive pulled for a moment, skips the pass: every file would read
 * as deleted and every note as empty.
 */
async function redrive(): Promise<void> {
  if (!isOnline) return
  const startedFor = generation
  const vaultPath = getCurrentVaultPath()
  if (!vaultPath || !isVaultReachable(vaultPath)) {
    log.info('Attachment upload re-drive skipped: the vault is not reachable')
    return
  }
  dropUploadsWithoutFile(vaultPath)
  try {
    // Same gate as the body outbox's pause: offline or without a token every
    // upload fails, and each failure would count an attempt against its row.
    if (!isOnline() || !(await getValidAccessToken())) return
    // The runtime may have stopped or moved to another vault during the token
    // wait; this pass must not back-fill or drain that vault's outbox.
    if (startedFor !== generation) return
    try {
      backfillUnsyncedAttachments()
    } catch (error) {
      // A backfill that cannot run must never keep the drain from retrying the
      // rows already pending.
      log.warn('Attachment backfill skipped', { error })
    }
    await drainAttachmentOutbox(vaultPath)
  } catch (error) {
    log.warn('Attachment upload re-drive failed', { error })
  }
}

function start(online: () => boolean): void {
  stop()
  generation++
  isOnline = online
  redriveTimer = setInterval(() => void redrive(), REDRIVE_INTERVAL_MS)
  redriveTimer.unref?.()
}

function stop(): void {
  if (redriveTimer) {
    clearInterval(redriveTimer)
    redriveTimer = null
  }
  generation++
  isOnline = null
}

export const attachmentUploadRedriver = { start, stop, redrive }
