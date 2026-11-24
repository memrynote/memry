import fs from 'fs'
import path from 'path'
import { asc, and, eq, sql } from 'drizzle-orm'
import { attachmentUploadQueue } from '@memry/db-schema/data-schema'
import { syncState } from '@memry/db-schema/schema/sync-state'
import { getNoteMetadataById } from '@memry/storage-data'
import { createLogger } from '../lib/logger'
import { trackMainLog } from '../telemetry/diagnostics'
import { isVaultReachable } from '../vault/init'
import { isStrayAttachmentNote } from '../vault/attachments'
import { UnsendableAttachmentError } from './attachment-errors'
import { SYNC_STATE_KEYS } from './engine/sync-context'
import { classifyError } from './sync-errors'
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

/** A file's size and mtime, as the uploader saw it when it refused the file. */
interface FileStamp {
  size: number
  mtimeMs: number
}

function stampOf(diskPath: string): FileStamp | null {
  try {
    const { size, mtimeMs } = fs.statSync(diskPath)
    return { size, mtimeMs }
  } catch {
    return null
  }
}

function sameStamp(a: FileStamp | undefined, b: FileStamp | null): boolean {
  return a !== undefined && b !== null && a.size === b.size && a.mtimeMs === b.mtimeMs
}

function isFileStamp(value: unknown): value is FileStamp {
  return (
    typeof value === 'object' &&
    value !== null &&
    'size' in value &&
    typeof value.size === 'number' &&
    'mtimeMs' in value &&
    typeof value.mtimeMs === 'number'
  )
}

function readRefusals(db: DrizzleDb): Map<string, FileStamp> {
  const value = db
    .select({ value: syncState.value })
    .from(syncState)
    .where(eq(syncState.key, SYNC_STATE_KEYS.ATTACHMENT_UPLOAD_REFUSALS))
    .get()?.value
  if (!value) return new Map()
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    // Forgetting the refusals costs one more offer of each refused file.
    log.warn('Attachment upload refusals are corrupt; starting them again', { error })
    return new Map()
  }
  if (typeof parsed !== 'object' || parsed === null) return new Map()
  return new Map(
    Object.entries(parsed).filter((entry): entry is [string, FileStamp] => isFileStamp(entry[1]))
  )
}

function writeRefusals(db: DrizzleDb, refusals: Map<string, FileStamp>): void {
  const key = SYNC_STATE_KEYS.ATTACHMENT_UPLOAD_REFUSALS
  if (refusals.size === 0) {
    db.delete(syncState).where(eq(syncState.key, key)).run()
    return
  }
  const value = JSON.stringify(Object.fromEntries(refusals))
  const updatedAt = new Date()
  db.insert(syncState)
    .values({ key, value, updatedAt })
    .onConflictDoUpdate({ target: syncState.key, set: { value, updatedAt } })
    .run()
}

/**
 * The uploader refused this file for good (`UnsendableAttachmentError`): drop
 * its row and remember the file's size and mtime. The backfill does not offer
 * the file again until a write changes them (#5606). Remembered refusals whose
 * file has changed or is gone hold nothing back, so they are let go here.
 */
export function refuseUpload(db: DrizzleDb, noteId: string, diskPath: string): void {
  clearUpload(db, noteId, diskPath)
  const refusals = new Map(
    [...readRefusals(db)].filter(([file, stamp]) => sameStamp(stamp, stampOf(file)))
  )
  const stamp = stampOf(diskPath)
  if (stamp) refusals.set(diskPath, stamp)
  writeRefusals(db, refusals)
}

/**
 * Whether the uploader would refuse this file as it is on disk now: it is
 * empty (`EmptyAttachmentError` depends on the size alone), or the uploader
 * refused it before and no write has changed it since. A file that cannot be
 * read is not judged here; the drain owns a missing file.
 */
function refusedAsItIs(db: DrizzleDb, diskPath: string): boolean {
  const stamp = stampOf(diskPath)
  if (stamp === null) return false
  return stamp.size === 0 || sameStamp(readRefusals(db).get(diskPath), stamp)
}

/**
 * Queue a file the backfill or a body write found, unless it already has a
 * row (a failed row keeps its attempts and its retry window) or the uploader
 * would refuse it as it is. Without the second check, a file the drain
 * dropped was found again on the next re-drive and dropped again, every five
 * minutes (#5606). True when a row was added.
 */
export function queueUploadIfAbsent(db: DrizzleDb, noteId: string, diskPath: string): boolean {
  if (refusedAsItIs(db, diskPath)) return false
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

/** An upload the server accepted: its id and the checksum of the bytes it sent. */
export interface UploadedFile {
  attachmentId: string
  sha256: string
}

export interface OutboxDrainDeps {
  db: DrizzleDb
  vaultPath: string
  /** Null: another path owns this upload and records its outcome; the row is left alone. */
  upload: (noteId: string, diskPath: string) => Promise<UploadedFile | null>
  /** Awaited before the row clears: a crash while it records retries the upload. */
  onUploaded?: (noteId: string, uploaded: UploadedFile, diskPath: string) => void | Promise<void>
  now?: number
}

function retryOpensAt(row: { attempts: number; updatedAt: number }): number {
  if (row.attempts === 0) return 0
  return row.updatedAt + Math.min(RETRY_BASE_MS * 2 ** (row.attempts - 1), RETRY_MAX_MS)
}

/**
 * The oldest rows whose retry window is open. Rows of a local-only note never
 * count toward the batch, so they cannot hold back the rows behind them. Nor
 * do a stray's (#5607): its file is the attachment store's, and its upload
 * would be a second blob of the file the embedding note already uploads.
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
    .filter(
      (row) =>
        retryOpensAt(row) <= now &&
        !isLocalOnlyNote(db, row.noteId) &&
        !isStrayAttachmentNote(db, row.noteId)
    )
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
 * was deleted, before or after the attempt, are dropped; rows the uploader
 * refuses for good are dropped and remembered (`refuseUpload`); rows whose
 * vault is unreachable wait untouched; rows that fail again stay queued with
 * an incremented attempt count and a longer window.
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
  // By reason, so the summary says why rows went, not only how many (#5606).
  const droppedBy: Record<string, number> = {}
  const countDrop = (reason: string): void => {
    dropped++
    droppedBy[reason] = (droppedBy[reason] ?? 0) + 1
  }

  for (const row of pending) {
    // The list is read once and each upload takes a while: a save-time upload
    // may have finished this row in the meantime, and uploading it again would
    // give the file a second attachment id.
    if (!hasPendingUpload(deps.db, row.noteId, row.diskPath)) continue
    const state = uploadFileState(deps.db, deps.vaultPath, row)
    if (state === 'unreachable') continue
    if (state === 'deleted') {
      clearUpload(deps.db, row.noteId, row.diskPath)
      countDrop('deleted')
      continue
    }
    try {
      const result = await deps.upload(row.noteId, row.diskPath)
      if (!result) continue
      await deps.onUploaded?.(row.noteId, result, row.diskPath)
      clearUpload(deps.db, row.noteId, row.diskPath)
      uploaded++
    } catch (err) {
      if (uploadFileState(deps.db, deps.vaultPath, row) === 'deleted') {
        clearUpload(deps.db, row.noteId, row.diskPath)
        countDrop('deleted')
        continue
      }
      if (err instanceof UnsendableAttachmentError) {
        refuseUpload(deps.db, row.noteId, row.diskPath)
        countDrop(err.name)
        continue
      }
      // A revoked device is refused identically for every remaining row, and
      // each try would count an attempt against a row that did nothing wrong
      // (#3414). Leave the row as it was and end the pass.
      if (classifyError(err).category === 'device_revoked') {
        log.warn('Attachment outbox drain stopped: this device was revoked')
        break
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
    const summary = { pending: pending.length, uploaded, failed, dropped, droppedBy }
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
let onUploadedForDrain: OutboxDrainDeps['onUploaded'] | null = null
let registeredQueueReset: (() => Promise<void>) | null = null
let draining = false

export function registerOutboxUploader(
  uploader: RegisteredUploader | null,
  getDb: (() => DrizzleDb) | null,
  onUploaded: OutboxDrainDeps['onUploaded'] | null
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
export function registerAttachmentQueueReset(reset: (() => Promise<void>) | null): void {
  registeredQueueReset = reset
}

/**
 * No-ops until the IPC layer has registered a disposer. Resolves once the
 * downloads it stopped have recorded their outcomes.
 */
export function resetAttachmentQueue(): Promise<void> {
  return registeredQueueReset?.() ?? Promise.resolve()
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
