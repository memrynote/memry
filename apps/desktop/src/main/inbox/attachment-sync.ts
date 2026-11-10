/**
 * Inbox attachment sync (#4157): the file behind an image, voice, video, PDF
 * or file capture travels between devices as one encrypted attachment, through
 * the shared upload and download queues, the way Home covers and canvas assets
 * do.
 *
 * `inbox_items.attachment_id` records the uploaded bytes and rides the item's
 * whole-row push as `attachmentId`. It is sticky: a remote payload never clears
 * it (inbox-handler). `inbox_attachment_uploads` is the device-local "upload
 * pending" mark, written in the capture's own transaction. Only a new capture
 * ever gets a mark, so a file captured before this feature stays on the device
 * that captured it.
 *
 * {@link reconcileInboxAttachments} settles both directions, is idempotent, and
 * runs after a capture, when sync starts or reconnects, and when a payload
 * brings a new attachment id:
 * - a pending capture is uploaded, then gets its attachment id through a normal
 *   local inbox update (clock bump, push). The mark is dropped without an id
 *   when the file is gone, the item was filed or deleted, or the server refuses
 *   the file (storage quota, plan file cap): that item stays local-only and its
 *   peers show a placeholder. Any other failure keeps the mark for the next pass.
 * - an unfiled item with an attachment id and no file on disk is downloaded
 *   into `attachments/inbox/<itemId>/`, nowhere else.
 *
 * Filing reuses the blob instead of uploading again: see
 * {@link reuseInboxAttachmentForNote}.
 *
 * @module inbox/attachment-sync
 */

import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import { InboxChannels } from '@memry/contracts/ipc-channels'
import { inboxAttachmentUploads, inboxItems } from '@memry/db-schema/schema/inbox'
import { getDatabase, isDatabaseInitialized } from '../database/client'
import type { DataDb } from '../database/types'
import { createLogger } from '../lib/logger'
import { normalizeRelativePath } from '../lib/paths'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import { recordAttachmentFile } from '../sync/attachment-files'
import { EmptyAttachmentError } from '../sync/attachment-errors'
import { recordUploadedAttachment } from '../sync/note-attachment-metadata'
import { getSyncEngine } from '../sync/runtime-state'
import { classifyError } from '../sync/sync-errors'
import { fileExists } from '../vault/file-ops'
import { getStatus as getVaultStatus } from '../vault/status'
import { publishInboxUpserted, syncInboxUpdate } from './runtime-effects'

const log = createLogger('InboxAttachmentSync')

/** The transfer half of the shared attachment queues, as this module needs it. */
export interface InboxAttachmentIO {
  uploadAttachment: (ownerId: string, filePath: string) => Promise<{ attachmentId: string }>
  downloadAttachmentIntoDir: (
    ownerId: string,
    attachmentId: string,
    targetDir: string
  ) => Promise<{ filePath: string }>
}

export interface InboxAttachmentDeps {
  db: DataDb
  vaultPath: string
  /** Defaults to the shared queues while sync runs. `null` means no transfer is possible now. */
  io?: InboxAttachmentIO | null
}

/** Server refusals that repeat identically on every retry. */
const REFUSED_CATEGORIES: ReadonlySet<string> = new Set([
  'storage_quota_exceeded',
  'file_too_large'
])

const uploading = new Set<string>()
const downloading = new Set<string>()

function isPlainSegment(value: string): boolean {
  return value.length > 0 && !/[/\\]/.test(value) && value !== '.' && value !== '..'
}

function itemDir(vaultPath: string, itemId: string): string {
  return path.join(vaultPath, 'attachments', 'inbox', itemId)
}

/** The absolute file a capture's `attachmentPath` names, or null unless it is exactly `attachments/inbox/<itemId>/<file>`. */
function ownFilePath(vaultPath: string, itemId: string, attachmentPath: string): string | null {
  const parts = attachmentPath.split('/')
  const [root, inbox, owner, name] = parts
  const ok =
    parts.length === 4 &&
    root === 'attachments' &&
    inbox === 'inbox' &&
    owner === itemId &&
    isPlainSegment(name)
  return ok ? path.join(itemDir(vaultPath, itemId), name) : null
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/**
 * Mark a capture's file as waiting for upload. Call it in the transaction that
 * inserts the item, for a syncable item whose file is not a thumbnail.
 */
export function queueInboxAttachmentUpload(
  db: Pick<DataDb, 'insert'>,
  itemId: string,
  now = Date.now()
): void {
  db.insert(inboxAttachmentUploads).values({ itemId, createdAt: now }).onConflictDoNothing().run()
}

function clearPending(db: DataDb, itemId: string): void {
  db.delete(inboxAttachmentUploads).where(eq(inboxAttachmentUploads.itemId, itemId)).run()
}

function readItem(db: DataDb, itemId: string) {
  return db.select().from(inboxItems).where(eq(inboxItems.id, itemId)).get()
}

async function uploadOne(deps: InboxAttachmentDeps, io: InboxAttachmentIO, itemId: string) {
  const { db, vaultPath } = deps
  if (uploading.has(itemId)) return
  const item = readItem(db, itemId)
  if (!item || item.filedAt || item.localOnly || item.attachmentId || !item.attachmentPath) {
    clearPending(db, itemId)
    return
  }
  const filePath = ownFilePath(vaultPath, itemId, item.attachmentPath)
  if (!filePath || !(await fileExists(filePath))) {
    log.info('Inbox attachment is gone; dropping its pending upload', { itemId })
    clearPending(db, itemId)
    return
  }

  uploading.add(itemId)
  try {
    const { attachmentId } = await io.uploadAttachment(itemId, filePath)
    // Filed or deleted while the upload ran: the file moved with it, and the
    // note it joined uploads its own copy.
    const current = readItem(db, itemId)
    if (!current || current.filedAt || current.attachmentId) {
      clearPending(db, itemId)
      return
    }
    db.transaction((tx) => {
      tx.update(inboxItems).set({ attachmentId }).where(eq(inboxItems.id, itemId)).run()
      tx.delete(inboxAttachmentUploads).where(eq(inboxAttachmentUploads.itemId, itemId)).run()
    })
    syncInboxUpdate(itemId)
    broadcastToAllWindows(InboxChannels.events.UPDATED, { id: itemId })
  } catch (error) {
    const { category } = classifyError(error)
    if (REFUSED_CATEGORIES.has(category) || error instanceof EmptyAttachmentError) {
      log.info('Inbox attachment will not sync; it stays on this device', { itemId, category })
      clearPending(db, itemId)
    } else if (isMissingFile(error)) {
      clearPending(db, itemId)
    } else {
      log.warn('Inbox attachment upload failed; the next reconcile retries it', {
        itemId,
        category,
        error
      })
    }
  } finally {
    uploading.delete(itemId)
  }
}

async function downloadOne(
  deps: InboxAttachmentDeps,
  io: InboxAttachmentIO,
  item: typeof inboxItems.$inferSelect
) {
  const { db, vaultPath } = deps
  const { id: itemId, attachmentId } = item
  if (!attachmentId || downloading.has(itemId)) return
  // The id came from a peer: it names a directory under attachments/inbox.
  if (!isPlainSegment(itemId)) {
    log.warn('Refusing to download an inbox attachment for an unsafe item id')
    return
  }
  const own = item.attachmentPath ? ownFilePath(vaultPath, itemId, item.attachmentPath) : null
  if (own && (await fileExists(own))) return

  const dir = itemDir(vaultPath, itemId)
  downloading.add(itemId)
  try {
    await mkdir(dir, { recursive: true })
    const { filePath } = await io.downloadAttachmentIntoDir(itemId, attachmentId, dir)
    const landed = path.resolve(filePath)
    if (path.dirname(landed) !== path.resolve(dir) || !isPlainSegment(path.basename(landed))) {
      log.error('Refusing an inbox attachment that landed outside its item folder', { itemId })
      return
    }
    const current = readItem(db, itemId)
    if (!current || current.filedAt) {
      await rm(landed, { force: true })
      return
    }
    db.update(inboxItems)
      .set({ attachmentPath: normalizeRelativePath(path.relative(vaultPath, landed)) })
      .where(eq(inboxItems.id, itemId))
      .run()
    publishInboxUpserted(itemId)
    broadcastToAllWindows(InboxChannels.events.UPDATED, { id: itemId })
  } catch (error) {
    log.warn('Inbox attachment download failed; the next reconcile retries it', { itemId, error })
  } finally {
    downloading.delete(itemId)
  }
}

async function defaultIO(): Promise<InboxAttachmentIO | null> {
  // Lazy: the IPC attachment module imports electron and builds the shared
  // queues on first use, and it reaches back into the sync layer this module
  // is loaded from. Building the queues before the sync runtime exists would
  // bind them to no network monitor for the rest of the session, so wait for
  // the engine.
  if (!getSyncEngine()) return null
  const { getCanvasAssetIO } = await import('../ipc/sync-attachment-handlers')
  return getCanvasAssetIO()
}

/**
 * Bring every inbox file in line with its row: upload what only this device
 * has, download what only the account has. Safe to call at any time.
 */
export async function reconcileInboxAttachments(deps: InboxAttachmentDeps): Promise<void> {
  const io = deps.io === undefined ? await defaultIO() : deps.io
  if (!io) return

  const pending = deps.db
    .select({ itemId: inboxAttachmentUploads.itemId })
    .from(inboxAttachmentUploads)
    .all()
  const missing = deps.db
    .select()
    .from(inboxItems)
    .where(and(isNotNull(inboxItems.attachmentId), isNull(inboxItems.filedAt)))
    .all()

  await Promise.all([
    ...pending.map(({ itemId }) => uploadOne(deps, io, itemId)),
    ...missing.map((item) => downloadOne(deps, io, item))
  ])
}

/**
 * Fire a reconcile against the open vault: after a capture, and when a pulled
 * item brings an attachment id. Never throws, and does nothing without a vault.
 */
export function scheduleInboxAttachmentSync(): void {
  const vaultPath = getVaultStatus().path
  if (!vaultPath || !isDatabaseInitialized()) return
  reconcileInboxAttachments({ db: getDatabase(), vaultPath }).catch((error: unknown) =>
    log.warn('Inbox attachment reconcile failed', { error })
  )
}

/**
 * A capture whose blob is already on the server joins a note without a second
 * upload: record the file against the note and add the id to the note's
 * references. Peers then download the bytes by that id.
 *
 * `diskPath` is the file's place in the vault after the move or copy. For an
 * embed it must be named like the inbox file (the manifest filename), because a
 * peer places the download in `attachments/<noteId>/` by that name.
 */
export function reuseInboxAttachmentForNote(
  db: DataDb,
  vaultPath: string,
  noteId: string,
  diskPath: string,
  attachmentId: string
): void {
  recordAttachmentFile(db, vaultPath, noteId, diskPath, attachmentId)
  recordUploadedAttachment(noteId, attachmentId)
}
