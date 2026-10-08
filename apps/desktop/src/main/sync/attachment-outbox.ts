import fs from 'fs'
import path from 'path'
import { asc, and, eq, sql } from 'drizzle-orm'
import { attachmentUploadQueue } from '@memry/db-schema/data-schema'
import { getNoteMetadataById } from '@memry/storage-data'
import { createLogger } from '../lib/logger'
import { trackMainLog } from '../telemetry/diagnostics'
import { isVaultReachable } from '../vault/init'
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
  vaultPath: string
  /** Null: another path owns this upload and records its outcome; the row is left alone. */
  upload: (noteId: string, diskPath: string) => Promise<{ attachmentId: string } | null>
  onUploaded?: (noteId: string, attachmentId: string) => void
  now?: number
}

function retryOpensAt(row: { attempts: number; updatedAt: number }): number {
  if (row.attempts === 0) return 0
  return row.updatedAt + Math.min(RETRY_BASE_MS * 2 ** (row.attempts - 1), RETRY_MAX_MS)
}

/**
 * The oldest rows whose retry window is open. Rows of a local-only note never
 * count toward the batch, so they cannot hold back the rows behind them.
 */
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
    .filter((row) => retryOpensAt(row) <= now && !isLocalOnlyNote(db, row.noteId))
    .slice(0, DRAIN_BATCH_LIMIT)
}

/**
 * A local-only note is deliberately kept off the server, so its rows stay
 * queued on the device and upload only if the flag is cleared.
 */
export function isLocalOnlyNote(db: DrizzleDb, noteId: string): boolean {
  return getNoteMetadataById(db, noteId)?.localOnly === true
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/**
 * A missing file was deleted only while its vault and its note's folder are
 * there. A removable or network vault that is away for a moment hides every
 * file at once, and reading that as deletion would drop every queued upload.
 */
export function uploadFileState(
  db: DrizzleDb,
  vaultPath: string,
  row: { noteId: string; diskPath: string }
): 'present' | 'deleted' | 'unreachable' {
  if (fs.existsSync(row.diskPath)) return 'present'
  if (!isVaultReachable(vaultPath)) return 'unreachable'
  const note = getNoteMetadataById(db, row.noteId)
  if (note && !isDirectory(path.dirname(path.join(vaultPath, note.path)))) return 'unreachable'
  return 'deleted'
}

/**
 * Try every pending upload whose retry window is open, once. Rows whose file
 * was deleted, before or after the attempt, are dropped; rows whose vault is
 * unreachable wait untouched; rows that fail again stay queued with an
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
    const state = uploadFileState(deps.db, deps.vaultPath, row)
    if (state === 'unreachable') continue
    if (state === 'deleted') {
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
      if (uploadFileState(deps.db, deps.vaultPath, row) === 'deleted') {
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
 * Drop rows whose file was deleted: they can never upload. Needs no network or
 * token, so the re-drive runs it before its online gate.
 */
export function dropUploadsWithoutFile(vaultPath: string): void {
  if (!getDbForDrain) return
  try {
    const db = getDbForDrain()
    const rows = db
      .select({ noteId: attachmentUploadQueue.noteId, diskPath: attachmentUploadQueue.diskPath })
      .from(attachmentUploadQueue)
      .all()
    for (const row of rows) {
      if (uploadFileState(db, vaultPath, row) === 'deleted')
        clearUpload(db, row.noteId, row.diskPath)
    }
  } catch (err) {
    log.warn('Dropping attachment uploads without a file failed', { error: err })
  }
}

export async function drainAttachmentOutbox(vaultPath: string): Promise<void> {
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
      vaultPath,
      upload: registeredUploader,
      ...(onUploadedForDrain ? { onUploaded: onUploadedForDrain } : {})
    })
  } catch (err) {
    log.warn('Attachment outbox drain failed', { error: err })
  } finally {
    draining = false
  }
}
