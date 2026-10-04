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
// A failed row waits before its next try, like a failed download: one minute
// after the first failure, doubling with each one, at most six hours.
const RETRY_BASE_MS = 60 * 1000
const RETRY_MAX_MS = 6 * 60 * 60 * 1000

/**
 * Durable outbox for note-attachment uploads.
 *
 * The in-memory UploadQueue only bounds concurrency — a failed upload used to
 * be logged and lost forever, leaving the note referencing a file that exists
 * on exactly one machine. Rows here are written before the upload is attempted
 * and deleted only once the server accepts the file, so pending uploads
 * survive restarts. The sync runtime retries them when it starts, every five
 * minutes, and on reconnect.
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

/**
 * Queue a file the backfill or a body write found, unless it already has a
 * row: a failed row keeps its attempts and its retry window. True when a row
 * was added.
 */
export function queueUploadIfAbsent(db: DrizzleDb, noteId: string, diskPath: string): boolean {
  const now = Date.now()
  const result = db
    .insert(attachmentUploadQueue)
    .values({ id: crypto.randomUUID(), noteId, diskPath, createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .run()
  return result.changes > 0
}

export function hasPendingUpload(db: DrizzleDb, noteId: string, diskPath: string): boolean {
  return (
    db
      .select({ id: attachmentUploadQueue.id })
      .from(attachmentUploadQueue)
      .where(
        and(eq(attachmentUploadQueue.noteId, noteId), eq(attachmentUploadQueue.diskPath, diskPath))
      )
      .get() !== undefined
  )
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
  /** Null: another path owns this upload and records its outcome; the row is left alone. */
  upload: (noteId: string, diskPath: string) => Promise<{ attachmentId: string } | null>
  onUploaded?: (noteId: string, attachmentId: string) => void
  now?: number
}

function retryOpensAt(row: { attempts: number; updatedAt: number }): number {
  if (row.attempts === 0) return 0
  return row.updatedAt + Math.min(RETRY_BASE_MS * 2 ** (row.attempts - 1), RETRY_MAX_MS)
}

/** The oldest rows whose retry window is open. */
function listDueUploads(
  db: DrizzleDb,
  now: number
): Array<{ noteId: string; diskPath: string; attempts: number }> {
  return db
    .select({
      noteId: attachmentUploadQueue.noteId,
      diskPath: attachmentUploadQueue.diskPath,
      attempts: attachmentUploadQueue.attempts,
      updatedAt: attachmentUploadQueue.updatedAt
    })
    .from(attachmentUploadQueue)
    .orderBy(asc(attachmentUploadQueue.updatedAt))
    .all()
    .filter((row) => retryOpensAt(row) <= now)
    .slice(0, DRAIN_BATCH_LIMIT)
}

/**
 * Try every pending upload whose retry window is open, once. Rows whose file no
 * longer exists on disk, before or after the attempt, are dropped (the
 * attachment was deleted locally); rows that fail again stay queued with an
 * incremented attempt count and a longer window.
 */
export async function drainOutboxWith(deps: OutboxDrainDeps): Promise<{
  uploaded: number
  failed: number
  dropped: number
}> {
  const pending = listDueUploads(deps.db, deps.now ?? Date.now())
  let uploaded = 0
  let failed = 0
  let dropped = 0

  for (const row of pending) {
    // The list is read once and each upload takes a while: a save-time upload
    // may have finished this row in the meantime, and uploading it again would
    // give the file a second attachment id.
    if (!hasPendingUpload(deps.db, row.noteId, row.diskPath)) continue
    if (!fs.existsSync(row.diskPath)) {
      clearUpload(deps.db, row.noteId, row.diskPath)
      dropped++
      continue
    }
    try {
      const result = await deps.upload(row.noteId, row.diskPath)
      if (!result) continue
      clearUpload(deps.db, row.noteId, row.diskPath)
      deps.onUploaded?.(row.noteId, result.attachmentId)
      uploaded++
    } catch (err) {
      if (!fs.existsSync(row.diskPath)) {
        clearUpload(deps.db, row.noteId, row.diskPath)
        dropped++
        continue
      }
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

type RegisteredUploader = OutboxDrainDeps['upload']

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

/**
 * Drop rows whose file is gone: they can never upload. Needs no network or
 * token, so the re-drive runs it before its online gate.
 */
export function dropUploadsWithoutFile(): void {
  if (!getDbForDrain) return
  try {
    const db = getDbForDrain()
    const rows = db
      .select({ noteId: attachmentUploadQueue.noteId, diskPath: attachmentUploadQueue.diskPath })
      .from(attachmentUploadQueue)
      .all()
    for (const row of rows) {
      if (!fs.existsSync(row.diskPath)) clearUpload(db, row.noteId, row.diskPath)
    }
  } catch (err) {
    log.warn('Dropping attachment uploads without a file failed', { error: err })
  }
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
