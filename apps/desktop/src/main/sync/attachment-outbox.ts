import fs from 'fs'
import { asc, and, eq, sql } from 'drizzle-orm'
import { attachmentUploadQueue } from '@memry/db-schema/data-schema'
import { createLogger } from '../lib/logger'
import { trackMainLog } from '../telemetry/diagnostics'
import type { DrizzleDb } from '@memry/sync-client/item-handlers/types'

const log = createLogger('AttachmentOutbox')

const DRAIN_BATCH_LIMIT = 50
// Rows have no attempt cap, so a row can fail on every drain forever with the
// only trackMainError long scrolled past (it fired on the first live attempt).
// Crossing this many attempts flags the row as stuck, exactly once.
const STUCK_UPLOAD_ATTEMPTS = 5

/**
 * Durable outbox for note-attachment uploads.
 *
 * The in-memory UploadQueue only bounds concurrency — a failed upload used to
 * be logged and lost forever, leaving the note referencing a file that exists
 * on exactly one machine. Rows here are written before the upload is attempted
 * and deleted only once the server accepts the file, so pending uploads
 * survive restarts and are retried whenever the sync runtime starts.
 */

export function enqueueUpload(db: DrizzleDb, noteId: string, diskPath: string): void {
  const now = Date.now()
  db.insert(attachmentUploadQueue)
    .values({ id: crypto.randomUUID(), noteId, diskPath, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [attachmentUploadQueue.noteId, attachmentUploadQueue.diskPath],
      set: { updatedAt: now }
    })
    .run()
}

export function clearUpload(db: DrizzleDb, noteId: string, diskPath: string): void {
  db.delete(attachmentUploadQueue)
    .where(
      and(eq(attachmentUploadQueue.noteId, noteId), eq(attachmentUploadQueue.diskPath, diskPath))
    )
    .run()
}

export function markUploadFailed(
  db: DrizzleDb,
  noteId: string,
  diskPath: string,
  error: string
): void {
  const now = Date.now()
  db.insert(attachmentUploadQueue)
    .values({
      id: crypto.randomUUID(),
      noteId,
      diskPath,
      attempts: 1,
      lastError: error,
      createdAt: now,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: [attachmentUploadQueue.noteId, attachmentUploadQueue.diskPath],
      set: {
        attempts: sql`${attachmentUploadQueue.attempts} + 1`,
        lastError: error,
        updatedAt: now
      }
    })
    .run()
}

export function listPendingUploads(
  db: DrizzleDb,
  limit: number = DRAIN_BATCH_LIMIT
): Array<{ noteId: string; diskPath: string; attempts: number }> {
  return db
    .select({
      noteId: attachmentUploadQueue.noteId,
      diskPath: attachmentUploadQueue.diskPath,
      attempts: attachmentUploadQueue.attempts
    })
    .from(attachmentUploadQueue)
    .orderBy(asc(attachmentUploadQueue.updatedAt))
    .limit(limit)
    .all()
}

export interface OutboxDrainDeps {
  db: DrizzleDb
  upload: (noteId: string, diskPath: string) => Promise<{ attachmentId: string }>
  onUploaded?: (noteId: string, attachmentId: string) => void
}

/**
 * Retry every pending upload once. Rows whose file no longer exists on disk
 * are dropped (the attachment was deleted locally); rows that fail again stay
 * queued with an incremented attempt count for the next drain.
 */
export async function drainOutboxWith(deps: OutboxDrainDeps): Promise<{
  uploaded: number
  failed: number
  dropped: number
}> {
  const pending = listPendingUploads(deps.db)
  let uploaded = 0
  let failed = 0
  let dropped = 0

  for (const row of pending) {
    if (!fs.existsSync(row.diskPath)) {
      clearUpload(deps.db, row.noteId, row.diskPath)
      dropped++
      continue
    }
    try {
      const result = await deps.upload(row.noteId, row.diskPath)
      clearUpload(deps.db, row.noteId, row.diskPath)
      deps.onUploaded?.(row.noteId, result.attachmentId)
      uploaded++
    } catch (err) {
      markUploadFailed(
        deps.db,
        row.noteId,
        row.diskPath,
        err instanceof Error ? err.message : String(err)
      )
      failed++
      // row.attempts is the pre-drain count; this failure persists attempts+1.
      if (row.attempts + 1 === STUCK_UPLOAD_ATTEMPTS) {
        trackMainLog('warn', {
          scope: 'AttachmentOutbox',
          action: 'attachment_outbox_stuck',
          metrics: { retryCount: row.attempts + 1 }
        })
      }
    }
  }

  if (pending.length > 0) {
    const summary = { pending: pending.length, uploaded, failed, dropped }
    // warn ships to log telemetry; info does not — a drain with failures must
    // be visible remotely.
    if (failed > 0) {
      log.warn('Attachment outbox drained', summary)
    } else {
      log.info('Attachment outbox drained', summary)
    }
  }
  return { uploaded, failed, dropped }
}

// ============================================================================
// Runtime wiring — the IPC layer owns the upload queue singleton, the sync
// runtime owns the start signal. The uploader is registered by the IPC layer;
// drainAttachmentOutbox() is safe to call any time (no-ops until registered).
// ============================================================================

type RegisteredUploader = (noteId: string, diskPath: string) => Promise<{ attachmentId: string }>

let registeredUploader: RegisteredUploader | null = null
let getDbForDrain: (() => DrizzleDb) | null = null
let onUploadedForDrain: ((noteId: string, attachmentId: string) => void) | null = null
let registeredQueueReset: (() => void) | null = null
let draining = false

export function registerOutboxUploader(
  uploader: RegisteredUploader | null,
  getDb: (() => DrizzleDb) | null,
  onUploaded: ((noteId: string, attachmentId: string) => void) | null
): void {
  registeredUploader = uploader
  getDbForDrain = getDb
  onUploadedForDrain = onUploaded
}

/**
 * The IPC layer owns the UploadQueue singleton, but the sync RUNTIME owns its
 * lifetime: the queue subscribes to the NetworkMonitor of the runtime that
 * built it and only detaches in dispose(). A queue that outlives its runtime is
 * therefore bound to a stopped monitor, whose `online` flag is frozen and which
 * can never emit 'status-changed' again — so the reconnect wake-up is dead and
 * the queue can still serve the wrong vault. The IPC layer registers its
 * disposer here; the runtime calls it on every teardown.
 */
export function registerAttachmentQueueReset(reset: (() => void) | null): void {
  registeredQueueReset = reset
}

/** No-ops until the IPC layer has registered a disposer. */
export function resetAttachmentQueue(): void {
  registeredQueueReset?.()
}

export async function drainAttachmentOutbox(): Promise<void> {
  if (draining) return
  if (!registeredUploader || !getDbForDrain) {
    log.debug('Attachment outbox drain skipped — no uploader registered')
    return
  }
  draining = true
  try {
    const db = getDbForDrain()
    await drainOutboxWith({
      db,
      upload: registeredUploader,
      ...(onUploadedForDrain ? { onUploaded: onUploadedForDrain } : {})
    })
  } catch (err) {
    log.warn('Attachment outbox drain failed', { error: err })
  } finally {
    draining = false
  }
}
