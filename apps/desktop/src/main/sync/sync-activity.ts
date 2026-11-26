/**
 * Sync failures in the vault activity log.
 *
 * Each of these already raises a toast, which is gone in ten seconds. The
 * activity log keeps them so the user can see afterwards which file or note did
 * not sync and why. A failure that keeps retrying is recorded once per file (or
 * note) per window, not once per attempt.
 *
 * @module sync/sync-activity
 */

import type { SyncStatusChangedEvent } from '@memry/contracts/ipc-events'
import { SYNC_EVENTS } from '@memry/contracts/ipc-sync'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import { recordActivity, toActivityPath } from '../vault/activity-log'
import { TextInMediaFileError } from './attachment-errors'

const SYNC_ACTIVITY_DEDUPE_MS = 6 * 60 * 60 * 1000

/** Record the status-channel failures that concern one note. Ignores everything else. */
export function recordSyncStatusActivity(event: unknown): void {
  if (!event || typeof event !== 'object') return
  const status = event as Partial<SyncStatusChangedEvent>
  if (status.errorCategory !== 'note_too_large') return
  recordActivity({
    kind: 'failed',
    source: 'sync',
    reason: 'note-too-large',
    ...(status.errorNoteTitle ? { message: status.errorNoteTitle } : {}),
    dedupeKey: `note-too-large:${status.errorNoteTitle ?? ''}`,
    dedupeWindowMs: SYNC_ACTIVITY_DEDUPE_MS
  })
}

export function recordAttachmentUploadFailure(
  diskPath: string,
  category: string,
  message: string
): void {
  recordActivity({
    kind: 'failed',
    source: 'sync',
    path: toActivityPath(diskPath),
    reason: category === 'file_too_large' ? 'file-too-large' : 'attachment-upload-failed',
    message,
    dedupeKey: `sync-upload:${diskPath}:${category}`,
    dedupeWindowMs: SYNC_ACTIVITY_DEDUPE_MS
  })
}

/**
 * An upload refused for good (`UnsendableAttachmentError`). A media file that
 * holds text (#5415) is told to the user with its reason; an empty file
 * (#3414) stays silent.
 */
export function reportRefusedUpload(noteId: string, diskPath: string, error: Error): void {
  if (!(error instanceof TextInMediaFileError)) return
  recordAttachmentUploadFailure(diskPath, 'text_in_media_file', error.message)
  broadcastToAllWindows(SYNC_EVENTS.ATTACHMENT_UPLOAD_FAILED, {
    noteId,
    diskPath,
    error: error.message,
    reason: error.message
  })
}

export function recordAttachmentDownloadFailure(diskPath: string, message: string): void {
  recordActivity({
    kind: 'failed',
    source: 'sync',
    path: toActivityPath(diskPath),
    reason: 'attachment-download-failed',
    message,
    dedupeKey: `sync-download:${diskPath}`,
    dedupeWindowMs: SYNC_ACTIVITY_DEDUPE_MS
  })
}
