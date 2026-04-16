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

import { AttachmentSyncService, type TransferProgress } from '../sync/attachments'
import { UploadQueue } from '../sync/upload-queue'
import { attachmentEvents } from '../sync/attachment-events'
import { markWritebackIgnored } from '../sync/crdt-writeback'
import { getStatus as getVaultStatus } from '../vault/index'

import { getDevicePublicKey, getOrDeriveVaultKey, secureCleanup, retrieveKey } from '../crypto'
import { getDatabase, isDatabaseInitialized } from '../database/client'
import { createLogger } from '../lib/logger'
import {
  recordDownloadedFileSize,
  recordUploadedAttachment
} from '../sync/note-attachment-metadata'
import { createValidatedHandler } from './validate'
import { getNetworkMonitor } from '../sync/runtime'
import { getValidAccessToken } from '../sync/token-manager'

const logger = createLogger('IPC:Sync:Attachments')

const SYNC_SERVER_URL = process.env.SYNC_SERVER_URL || 'http://localhost:8787'

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
    getAccessToken: () => getValidAccessToken(),
    getVaultKey: () => getOrDeriveVaultKey().catch(() => null),
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
    getSyncServerUrl: () => SYNC_SERVER_URL
  })

  return attachmentService
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
  ipcMain.handle(
    SYNC_CHANNELS.UPLOAD_ATTACHMENT,
    createValidatedHandler(UploadAttachmentSchema, async (input) => {
      const token = await getValidAccessToken()
      if (!token) return { success: false, error: 'Not authenticated' }

      const queue = getOrCreateUploadQueue()
      if (!queue) return { success: false, error: 'Sync not initialized' }

      try {
        const result = await queue.enqueue(input.noteId, input.filePath, broadcastUploadProgress)
        return { success: true, attachmentId: result.attachmentId, sessionId: result.sessionId }
      } catch (err) {
        logger.error('Attachment upload failed', err)
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
    })
  )

  ipcMain.handle(
    SYNC_CHANNELS.GET_UPLOAD_PROGRESS,
    createValidatedHandler(GetUploadProgressSchema, (input) => {
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
    })
  )

  ipcMain.handle(
    SYNC_CHANNELS.DOWNLOAD_ATTACHMENT,
    createValidatedHandler(DownloadAttachmentSchema, async (input) => {
      const token = await getValidAccessToken()
      if (!token) return { success: false, error: 'Not authenticated' }

      const service = getOrCreateAttachmentService()
      if (!service) return { success: false, error: 'Sync not initialized' }

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
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      } finally {
        service.setProgressCallback(null)
      }
    })
  )

  ipcMain.handle(
    SYNC_CHANNELS.GET_DOWNLOAD_PROGRESS,
    createValidatedHandler(GetDownloadProgressSchema, (input) => {
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
    })
  )

  attachmentEvents.onSaved(async ({ noteId, diskPath }) => {
    const token = await getValidAccessToken()
    if (!token) return

    const queue = getOrCreateUploadQueue()
    if (!queue) return
    try {
      const result = await queue.enqueue(noteId, diskPath, broadcastUploadProgress)
      if (isDatabaseInitialized()) {
        recordUploadedAttachment(noteId, result.attachmentId)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      logger.error('Attachment upload failed', { noteId, diskPath, error: message })
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(SYNC_EVENTS.ATTACHMENT_UPLOAD_FAILED, {
          noteId,
          diskPath,
          error: message
        })
      }
    }
  })

  attachmentEvents.onDownloadNeeded(async ({ noteId, attachmentId, diskPath }) => {
    const token = await getValidAccessToken()
    if (!token) return

    const service = getOrCreateAttachmentService()
    if (!service) return
    try {
      markWritebackIgnored(diskPath)
      await service.downloadAttachment(attachmentId, diskPath)
      const stats = await fs.promises.stat(diskPath)
      if (isDatabaseInitialized()) {
        recordDownloadedFileSize(noteId, stats.size)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      logger.error('Attachment download failed', { noteId, attachmentId, diskPath, error: message })
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(SYNC_EVENTS.ATTACHMENT_UPLOAD_FAILED, {
          noteId,
          diskPath,
          error: message
        })
      }
    }
  })
}

export function unregisterAttachmentHandlers(): void {
  attachmentEvents.removeAllListeners('saved')
  attachmentEvents.removeAllListeners('download-needed')

  ipcMain.removeHandler(SYNC_CHANNELS.UPLOAD_ATTACHMENT)
  ipcMain.removeHandler(SYNC_CHANNELS.GET_UPLOAD_PROGRESS)
  ipcMain.removeHandler(SYNC_CHANNELS.DOWNLOAD_ATTACHMENT)
  ipcMain.removeHandler(SYNC_CHANNELS.GET_DOWNLOAD_PROGRESS)
}
