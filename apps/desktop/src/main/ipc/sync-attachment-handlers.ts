import { BrowserWindow, ipcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import sodium from 'libsodium-wrappers-sumo'
import { eq } from 'drizzle-orm'

import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import { KEYCHAIN_ENTRIES } from '@memry/contracts/crypto'
import { SYNC_CHANNELS, SYNC_EVENTS } from '@memry/contracts/ipc-sync'
import {
  UploadAttachmentSchema,
  GetUploadProgressSchema,
  DownloadAttachmentSchema,
  GetDownloadProgressSchema
} from '@memry/contracts/ipc-attachments'

import {
  AttachmentSyncService,
  AttachmentTooLargeError,
  type TransferProgress,
  type UploadResult
} from '../sync/attachments'
import { classifyError } from '../sync/sync-errors'
import {
  getCachedMaxFileSize,
  invalidateCachedEntitlementLimits
} from '../billing/entitlement-cache'
import { trackMainError } from '../telemetry/diagnostics'
import { UploadQueue } from '../sync/upload-queue'
import { attachmentEvents } from '../sync/attachment-events'
import {
  enqueueUpload,
  clearUpload,
  markUploadFailed,
  registerOutboxUploader
} from '../sync/attachment-outbox'
import { markWritebackIgnored } from '../sync/crdt-writeback'
import { getStatus as getVaultStatus } from '../vault/index'

import {
  getDevicePublicKey,
  getOrInitializeLocalVaultKey,
  secureCleanup,
  retrieveKey
} from '../crypto'
import { getDatabase, isDatabaseInitialized } from '../database/client'
import { createLogger } from '../lib/logger'
import {
  recordDownloadedFileSize,
  recordUploadedAttachment
} from '../sync/note-attachment-metadata'
import { registerCommand } from './lib/register-command'
import { getNetworkMonitor } from '../sync/runtime'
import { resolveSyncServerUrl } from '../sync/sync-server-url'
import { getValidAccessToken } from '../sync/token-manager'
import { getOrCreateVaultUuid } from '../agent/storage/vault-id'
import { getMainI18n } from '../lib/main-i18n'

const logger = createLogger('IPC:Sync:Attachments')

// ============================================================================
// Attachment Service (lazy singleton)
// ============================================================================

let attachmentService: AttachmentSyncService | null = null
let uploadQueue: UploadQueue | null = null

const getOrCreateUploadQueue = (): UploadQueue | null => {
  if (uploadQueue) return uploadQueue
  const service = getOrCreateAttachmentService()
  if (!service) return null
  uploadQueue = new UploadQueue(
    service.uploadAttachment.bind(service),
    getNetworkMonitor() ?? undefined
  )
  return uploadQueue
}

const broadcastUploadProgress = (progress: TransferProgress): void => {
  const percent =
    progress.totalChunks > 0
      ? Math.round((progress.chunksCompleted / progress.totalChunks) * 100)
      : 0
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(SYNC_EVENTS.UPLOAD_PROGRESS, {
      attachmentId: progress.attachmentId,
      sessionId: '',
      progress: percent,
      status: progress.phase
    })
  }
}

const getOrCreateAttachmentService = (): AttachmentSyncService | null => {
  if (attachmentService) return attachmentService

  attachmentService = new AttachmentSyncService({
    getMaxFileSize: () => getCachedMaxFileSize(),
    getAccessToken: () => getValidAccessToken(),
    getVaultKey: async () => {
      if (!isDatabaseInitialized()) return null
      const db = getDatabase()
      return getOrInitializeLocalVaultKey(db, getOrCreateVaultUuid(db)).catch(() => null)
    },
    getSigningKeys: async () => {
      const secretKey = await retrieveKey(KEYCHAIN_ENTRIES.DEVICE_SIGNING_KEY)
      if (!secretKey) return null
      const publicKey = getDevicePublicKey(secretKey)
      if (!isDatabaseInitialized()) {
        secureCleanup(secretKey)
        return null
      }
      const db = getDatabase()
      const device = db
        .select({ id: syncDevices.id })
        .from(syncDevices)
        .where(eq(syncDevices.isCurrentDevice, true))
        .get()
      if (!device) {
        secureCleanup(secretKey)
        return null
      }
      return { secretKey, publicKey, deviceId: device.id }
    },
    getDevicePublicKey: async (deviceId: string) => {
      if (!isDatabaseInitialized()) return null
      const db = getDatabase()
      const device = db
        .select({ signingPublicKey: syncDevices.signingPublicKey })
        .from(syncDevices)
        .where(eq(syncDevices.id, deviceId))
        .get()
      if (!device?.signingPublicKey) return null
      return sodium.from_base64(device.signingPublicKey, sodium.base64_variants.ORIGINAL)
    },
    getSyncServerUrl: () => resolveSyncServerUrl()
  })

  return attachmentService
}

/**
 * Bound upload/download IO over the SHARED attachment singletons, for the
 * canvas asset service to reuse (no second queue/service). Uploads go through
 * the upload queue (network gating + backoff) and return the full manifest;
 * downloads go straight through the service. Returns null only if the sync
 * singletons cannot be constructed.
 */
export function getCanvasAssetIO(): {
  uploadAttachment: (canvasId: string, filePath: string) => Promise<UploadResult>
  downloadAttachment: (attachmentId: string, targetPath: string) => Promise<void>
} | null {
  const queue = getOrCreateUploadQueue()
  const service = getOrCreateAttachmentService()
  if (!queue || !service) return null
  return {
    uploadAttachment: (canvasId, filePath) =>
      queue.enqueue(canvasId, filePath, broadcastUploadProgress),
    downloadAttachment: async (attachmentId, targetPath) => {
      await service.downloadAttachment(attachmentId, targetPath)
    }
  }
}

export function clearAttachmentState(): void {
  if (uploadQueue) {
    uploadQueue.dispose()
    uploadQueue = null
  }
  attachmentService = null
}

// ============================================================================
// Handler Registration
// ============================================================================

export function registerAttachmentHandlers(): void {
  registerCommand(
    SYNC_CHANNELS.UPLOAD_ATTACHMENT,
    UploadAttachmentSchema,
    async (input) => {
      const token = await getValidAccessToken()
      if (!token) return { success: false, error: getMainI18n().t('errors:auth.notAuthenticated') }

      const queue = getOrCreateUploadQueue()
      if (!queue)
        return { success: false, error: getMainI18n().t('errors:sync.engineNotInitialized') }

      try {
        const result = await queue.enqueue(input.noteId, input.filePath, broadcastUploadProgress)
        return { success: true, attachmentId: result.attachmentId, sessionId: result.sessionId }
      } catch (err) {
        logger.error('Attachment upload failed', err)
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
    'errors:attachment.uploadFailed'
  )

  registerCommand(
    SYNC_CHANNELS.GET_UPLOAD_PROGRESS,
    GetUploadProgressSchema,
    (input) => {
      const service = getOrCreateAttachmentService()
      if (!service) return null
      const progress = service.getUploadProgress(input.sessionId)
      if (!progress) return null
      return {
        progress:
          progress.totalChunks > 0
            ? Math.round((progress.chunksCompleted / progress.totalChunks) * 100)
            : 0,
        uploadedChunks: progress.chunksCompleted,
        totalChunks: progress.totalChunks,
        status: 'uploading' as const
      }
    },
    'errors:attachment.uploadProgressFailed'
  )

  registerCommand(
    SYNC_CHANNELS.DOWNLOAD_ATTACHMENT,
    DownloadAttachmentSchema,
    async (input) => {
      const token = await getValidAccessToken()
      if (!token) return { success: false, error: getMainI18n().t('errors:auth.notAuthenticated') }

      const service = getOrCreateAttachmentService()
      if (!service)
        return { success: false, error: getMainI18n().t('errors:sync.engineNotInitialized') }

      service.setProgressCallback((progress) => {
        const percent =
          progress.totalChunks > 0
            ? Math.round((progress.chunksCompleted / progress.totalChunks) * 100)
            : 0
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send(SYNC_EVENTS.DOWNLOAD_PROGRESS, {
            attachmentId: progress.attachmentId,
            progress: percent,
            status: progress.phase
          })
        }
      })

      try {
        const targetPath = input.targetPath ?? ''
        if (!targetPath) return { success: false, error: 'Target path is required' }

        const vaultStatus = getVaultStatus()
        if (vaultStatus.path) {
          const resolved = path.resolve(targetPath)
          const vaultAttachments = path.resolve(vaultStatus.path, 'attachments')
          if (!resolved.startsWith(vaultAttachments + path.sep) && resolved !== vaultAttachments) {
            return {
              success: false,
              error: 'Target path must be within the vault attachments directory'
            }
          }
        }

        const result = await service.downloadAttachment(input.attachmentId, targetPath)
        return { success: true, filePath: result.filePath }
      } catch (err) {
        logger.error('Attachment download failed', err)
        trackMainError('sync_attachments', 'attachment_download_failed', err)
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      } finally {
        service.setProgressCallback(null)
      }
    },
    'errors:attachment.downloadFailed'
  )

  registerCommand(
    SYNC_CHANNELS.GET_DOWNLOAD_PROGRESS,
    GetDownloadProgressSchema,
    (input) => {
      const service = getOrCreateAttachmentService()
      if (!service) return null
      const progress = service.getDownloadProgress(input.attachmentId)
      if (!progress) return null
      return {
        progress:
          progress.totalChunks > 0
            ? Math.round((progress.chunksCompleted / progress.totalChunks) * 100)
            : 0,
        downloadedChunks: progress.chunksCompleted,
        totalChunks: progress.totalChunks,
        status: 'downloading' as const
      }
    },
    'errors:attachment.downloadProgressFailed'
  )

  registerOutboxUploader(
    async (noteId, diskPath) => {
      const queue = getOrCreateUploadQueue()
      if (!queue) throw new Error('Sync not initialized')
      const result = await queue.enqueue(noteId, diskPath, broadcastUploadProgress)
      return { attachmentId: result.attachmentId }
    },
    () => getDatabase(),
    (noteId, attachmentId) => recordUploadedAttachment(noteId, attachmentId)
  )

  attachmentEvents.onSaved(({ noteId, diskPath }) => {
    void (async () => {
      // Persist intent BEFORE attempting: if the upload fails or the app quits
      // mid-transfer, the outbox row survives and the next sync runtime start
      // retries it — previously a failed upload was logged and lost forever.
      if (isDatabaseInitialized()) {
        try {
          enqueueUpload(getDatabase(), noteId, diskPath)
        } catch (outboxErr) {
          logger.warn('Failed to persist attachment upload intent', { noteId, err: outboxErr })
        }
      }

      const token = await getValidAccessToken()
      if (!token) return

      const queue = getOrCreateUploadQueue()
      if (!queue) return
      try {
        const result = await queue.enqueue(noteId, diskPath, broadcastUploadProgress)
        if (isDatabaseInitialized()) {
          recordUploadedAttachment(noteId, result.attachmentId)
          // Outbox cleanup must never turn a successful upload into a failure.
          try {
            clearUpload(getDatabase(), noteId, diskPath)
          } catch (outboxErr) {
            logger.warn('Failed to clear attachment upload intent', { noteId, err: outboxErr })
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        // Classify here: this is the only path that raises the plan preflight's
        // AttachmentTooLargeError, and nothing else on it ever calls
        // classifyError — so without this the `file_too_large` category never
        // reaches a user and they just get the generic "stays on this device".
        const { category } = classifyError(err)
        logger.error('Attachment upload failed', { noteId, diskPath, error: message, category })
        if (isDatabaseInitialized()) {
          try {
            markUploadFailed(getDatabase(), noteId, diskPath, message)
          } catch (outboxErr) {
            logger.warn('Failed to record attachment upload failure', { noteId, err: outboxErr })
          }
        }
        // electron-log alone kept this outage invisible for 58 days — the only
        // reason it surfaced was a server-side 413. Route it to telemetry too so
        // an attachment outage is visible from the client side.
        trackMainError('sync_attachments', 'attachment_upload_failed', err)

        // The SERVER rejected on its own file-size limit, which means our cached
        // limit disagrees with the authority. Drop it so the next preflight has
        // no opinion and defers to the server instead of repeating a wrong call.
        // A local preflight rejection proves nothing about the server, so it must
        // not invalidate anything.
        //
        // The instanceof check is what separates the two: a local block and a
        // server 413 both classify as `file_too_large`, but only the local one is
        // an AttachmentTooLargeError. This relies on the invariant that
        // AttachmentTooLargeError is thrown ONLY outside any withRetry wrapper (it
        // is — the preflight throws before the first chunked request), so it is
        // never dead-lettered. Were it thrown inside retry, classifyError would
        // unwrap the DeadLetterError to file_too_large while `err` stayed a
        // DeadLetterError, and this guard would wrongly invalidate on a local block.
        if (category === 'file_too_large' && !(err instanceof AttachmentTooLargeError)) {
          logger.warn('Server rejected on plan file size — invalidating cached plan limits', {
            noteId
          })
          invalidateCachedEntitlementLimits()
        }

        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send(SYNC_EVENTS.ATTACHMENT_UPLOAD_FAILED, {
            noteId,
            diskPath,
            error: message,
            errorCategory: category
          })
        }
      }
    })()
  })

  attachmentEvents.onDownloadNeeded(({ noteId, attachmentId, diskPath, intoDir }) => {
    void (async () => {
      const token = await getValidAccessToken()
      if (!token) return

      const service = getOrCreateAttachmentService()
      if (!service) return
      try {
        markWritebackIgnored(diskPath)
        const result = intoDir
          ? await service.downloadAttachment(attachmentId, diskPath, { targetIsDir: true })
          : await service.downloadAttachment(attachmentId, diskPath)
        // Embedded attachments land inside attachments/<noteId>/ — the note's
        // own fileSize (a binary-note concept) must not be overwritten by them.
        if (!intoDir) {
          const stats = await fs.promises.stat(result.filePath)
          if (isDatabaseInitialized()) {
            recordDownloadedFileSize(noteId, stats.size)
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        logger.error('Attachment download failed', {
          noteId,
          attachmentId,
          diskPath,
          error: message
        })
        // Mirrors the upload path above — a download-side outage (auth, R2,
        // decrypt) must not repeat the 58-day blindness the upload path had.
        trackMainError('sync_attachments', 'attachment_download_failed', err)
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send(SYNC_EVENTS.ATTACHMENT_UPLOAD_FAILED, {
            noteId,
            diskPath,
            error: message
          })
        }
      }
    })()
  })
}

export function unregisterAttachmentHandlers(): void {
  registerOutboxUploader(null, null, null)
  attachmentEvents.removeAllListeners('saved')
  attachmentEvents.removeAllListeners('download-needed')

  ipcMain.removeHandler(SYNC_CHANNELS.UPLOAD_ATTACHMENT)
  ipcMain.removeHandler(SYNC_CHANNELS.GET_UPLOAD_PROGRESS)
  ipcMain.removeHandler(SYNC_CHANNELS.DOWNLOAD_ATTACHMENT)
  ipcMain.removeHandler(SYNC_CHANNELS.GET_DOWNLOAD_PROGRESS)
}
