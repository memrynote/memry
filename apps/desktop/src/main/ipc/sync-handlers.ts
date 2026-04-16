import { BrowserWindow, ipcMain } from 'electron'
import fs from 'node:fs'
import sodium from 'libsodium-wrappers-sumo'

import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import { KEYCHAIN_ENTRIES } from '@memry/contracts/crypto'
import { SYNC_CHANNELS, SYNC_EVENTS } from '@memry/contracts/ipc-sync'
import {
  GetHistorySchema,
  StorageBreakdownResult,
  UpdateSyncedSettingSchema
} from '@memry/contracts/ipc-sync-ops'
import {
  UploadAttachmentSchema,
  GetUploadProgressSchema,
  DownloadAttachmentSchema,
  GetDownloadProgressSchema
} from '@memry/contracts/ipc-attachments'
import path from 'node:path'
import { AttachmentSyncService, type TransferProgress } from '../sync/attachments'
import { UploadQueue } from '../sync/upload-queue'
import { attachmentEvents } from '../sync/attachment-events'
import { markWritebackIgnored } from '../sync/crdt-writeback'
import { getSettingsSyncManager } from '../sync/settings-sync'
import { getStatus as getVaultStatus } from '../vault/index'
import { syncHistory } from '@memry/db-schema/schema/sync-history'

import { eq, desc, count } from 'drizzle-orm'

import type { SyncEngine } from '../sync/engine'

import { getDevicePublicKey, getOrDeriveVaultKey, secureCleanup, retrieveKey } from '../crypto'
import { getDatabase, isDatabaseInitialized } from '../database/client'
import { getFromServer } from '../sync/http-client'

import { createLogger } from '../lib/logger'
import {
  recordDownloadedFileSize,
  recordUploadedAttachment
} from '../sync/note-attachment-metadata'
import { createValidatedHandler, withErrorHandler } from './validate'
import { getNetworkMonitor, getSyncEngine } from '../sync/runtime'
import { teardownSession } from '../sync/session-teardown'
import { getValidAccessToken, cancelTokenRefresh } from '../sync/token-manager'
import {
  clearOAuthState,
  registerAuthOAuthHandlers,
  unregisterAuthOAuthHandlers
} from './auth-oauth-handlers'
import {
  clearAuthDeviceState,
  registerAuthDeviceHandlers,
  unregisterAuthDeviceHandlers
} from './auth-device-handlers'

export { seedOAuthSession } from './auth-oauth-handlers'

const logger = createLogger('IPC:Sync')

const SYNC_SERVER_URL = process.env.SYNC_SERVER_URL || 'http://localhost:8787'

const parseSyncHistoryDetails = (details: string): unknown => {
  try {
    return JSON.parse(details) as unknown
  } catch {
    return details
  }
}

// ============================================================================
// Startup Integrity Check
// ============================================================================

export async function checkSyncIntegrity(): Promise<void> {
  if (!isDatabaseInitialized()) {
    logger.debug('Skipping sync integrity check — no vault open')
    return
  }
  try {
    const db = getDatabase()
    const currentDevice = db
      .select()
      .from(syncDevices)
      .where(eq(syncDevices.isCurrentDevice, true))
      .get()

    if (!currentDevice) return

    const masterKey = await retrieveKey(KEYCHAIN_ENTRIES.MASTER_KEY).catch(() => null)
    if (!masterKey) {
      logger.error(
        'Detected orphaned device registration — master key missing from keychain. ' +
          'Cleaning up local state. User will need to re-authenticate.',
        { deviceId: currentDevice.id }
      )
      await cleanupLocalSyncState()
      return
    }

    const signingKey = await retrieveKey(KEYCHAIN_ENTRIES.DEVICE_SIGNING_KEY).catch(() => null)
    if (!signingKey) {
      logger.error(
        'Signing key missing from keychain but device registered. ' +
          'Cleaning up local state. User will need to re-authenticate.',
        { deviceId: currentDevice.id }
      )
      await cleanupLocalSyncState()
      return
    }

    const derivedPubKey = getDevicePublicKey(signingKey)
    secureCleanup(signingKey)
    const derivedPubKeyB64 = sodium.to_base64(derivedPubKey, sodium.base64_variants.ORIGINAL)

    if (currentDevice.signingPublicKey && currentDevice.signingPublicKey !== derivedPubKeyB64) {
      logger.warn(
        'Signing key mismatch: DB public key does not match keychain-derived key. ' +
          'Self-healing by updating DB to match keychain (keychain is authority).',
        { deviceId: currentDevice.id }
      )
      db.update(syncDevices)
        .set({ signingPublicKey: derivedPubKeyB64 })
        .where(eq(syncDevices.id, currentDevice.id))
        .run()
      return
    }
  } catch (err) {
    logger.error('Sync integrity check failed', err)
  }
}

async function cleanupLocalSyncState(): Promise<void> {
  await teardownSession('integrity')
}

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

// ============================================================================
// Exported cleanup helper for session-teardown module
// ============================================================================

export function clearInMemoryAuthState(): void {
  clearAuthDeviceState()
  clearOAuthState()
  if (uploadQueue) {
    uploadQueue.dispose()
    uploadQueue = null
  }
  attachmentService = null
}

// ============================================================================
// Handler Registration
// ============================================================================

export function registerSyncHandlers(syncEngine?: SyncEngine): void {
  const resolveSyncEngine = (): SyncEngine | null => syncEngine ?? getSyncEngine()

  registerAuthOAuthHandlers()
  registerAuthDeviceHandlers()

  ipcMain.handle(SYNC_CHANNELS.GET_STATUS, () => {
    const engine = resolveSyncEngine()
    if (!engine) return { status: 'idle', pendingCount: 0 }
    return engine.getStatus()
  })

  ipcMain.handle(SYNC_CHANNELS.TRIGGER_SYNC, async () => {
    const engine = resolveSyncEngine()
    if (!engine) {
      return { success: false, error: 'Sync engine not initialized. Open a vault to start sync.' }
    }
    return withErrorHandler(async () => {
      await engine.fullSync()
      return { success: true }
    }, 'Sync failed')()
  })

  ipcMain.handle(
    SYNC_CHANNELS.GET_HISTORY,
    createValidatedHandler(GetHistorySchema, (input) => {
      if (!isDatabaseInitialized()) {
        return { entries: [], total: 0 }
      }
      const db = getDatabase()
      const limit = input.limit ?? 50
      const offset = input.offset ?? 0

      const rows = db
        .select()
        .from(syncHistory)
        .orderBy(desc(syncHistory.createdAt))
        .limit(limit)
        .offset(offset)
        .all()

      const [totalRow] = db.select({ total: count() }).from(syncHistory).all()

      return {
        entries: rows.map((r) => ({
          id: r.id,
          type: r.type as 'push' | 'pull' | 'error',
          itemCount: r.itemCount,
          direction: r.direction ?? undefined,
          details: r.details ? parseSyncHistoryDetails(r.details) : undefined,
          durationMs: r.durationMs ?? undefined,
          createdAt: r.createdAt.getTime()
        })),
        total: totalRow?.total ?? 0
      }
    })
  )

  ipcMain.handle(SYNC_CHANNELS.GET_QUEUE_SIZE, () => {
    const engine = resolveSyncEngine()
    if (!engine) return { pending: 0, failed: 0 }
    const stats = engine.getQueueStats()
    return { pending: stats.pending, failed: stats.failed }
  })

  ipcMain.handle(SYNC_CHANNELS.PAUSE, () => {
    const engine = resolveSyncEngine()
    if (!engine) return { success: false, wasPaused: false }
    return engine.pause()
  })

  ipcMain.handle(SYNC_CHANNELS.RESUME, () => {
    const engine = resolveSyncEngine()
    if (!engine) return { success: false, pendingCount: 0 }
    return engine.resume()
  })

  ipcMain.handle(SYNC_CHANNELS.UPDATE_SYNCED_SETTING, (_event, input: unknown) => {
    const parsed = UpdateSyncedSettingSchema.parse(input)
    const manager = getSettingsSyncManager()
    if (!manager) return { success: false, error: 'Settings sync not initialized' }

    manager.updateField(parsed.fieldPath, parsed.value, 'local')
    return { success: true }
  })

  ipcMain.handle(SYNC_CHANNELS.GET_SYNCED_SETTINGS, () => {
    const manager = getSettingsSyncManager()
    if (!manager) return null
    return manager.getSettings()
  })

  ipcMain.handle(SYNC_CHANNELS.GET_STORAGE_BREAKDOWN, async () => {
    const token = await getValidAccessToken()
    if (!token) return null
    return getFromServer<StorageBreakdownResult>('/sync/storage', token)
  })

  // --- Attachment Sync Handlers (T159–T162) ---

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

  ipcMain.handle(SYNC_CHANNELS.GET_QUARANTINED_ITEMS, () => {
    const engine = resolveSyncEngine()
    if (!engine) return []
    return engine.getQuarantinedItems()
  })

  ipcMain.handle(SYNC_CHANNELS.CHECK_DEVICE_STATUS, async () => {
    const engine = resolveSyncEngine()
    if (!engine) return { status: 'unknown' }
    const status = await engine.checkDeviceStatus()
    return { status }
  })

  ipcMain.handle(SYNC_CHANNELS.EMERGENCY_WIPE, async () => {
    const engine = resolveSyncEngine()
    if (engine) {
      await engine.performEmergencyWipe()
    }
    const result = await teardownSession('integrity')
    logger.warn('SECURITY_AUDIT: Emergency wipe via IPC complete')
    return { success: result.success }
  })
}

export function unregisterSyncHandlers(): void {
  unregisterAuthOAuthHandlers()
  unregisterAuthDeviceHandlers()

  attachmentEvents.removeAllListeners('saved')
  attachmentEvents.removeAllListeners('download-needed')
  cancelTokenRefresh()
  uploadQueue?.dispose()
  uploadQueue = null
  attachmentService = null

  ipcMain.removeHandler(SYNC_CHANNELS.GET_STATUS)
  ipcMain.removeHandler(SYNC_CHANNELS.TRIGGER_SYNC)
  ipcMain.removeHandler(SYNC_CHANNELS.GET_HISTORY)
  ipcMain.removeHandler(SYNC_CHANNELS.GET_QUEUE_SIZE)
  ipcMain.removeHandler(SYNC_CHANNELS.PAUSE)
  ipcMain.removeHandler(SYNC_CHANNELS.RESUME)
  ipcMain.removeHandler(SYNC_CHANNELS.CHECK_DEVICE_STATUS)
  ipcMain.removeHandler(SYNC_CHANNELS.EMERGENCY_WIPE)
  ipcMain.removeHandler(SYNC_CHANNELS.GET_QUARANTINED_ITEMS)

  ipcMain.removeHandler(SYNC_CHANNELS.UPDATE_SYNCED_SETTING)
  ipcMain.removeHandler(SYNC_CHANNELS.GET_SYNCED_SETTINGS)
  ipcMain.removeHandler(SYNC_CHANNELS.GET_STORAGE_BREAKDOWN)

  ipcMain.removeHandler(SYNC_CHANNELS.UPLOAD_ATTACHMENT)
  ipcMain.removeHandler(SYNC_CHANNELS.GET_UPLOAD_PROGRESS)
  ipcMain.removeHandler(SYNC_CHANNELS.DOWNLOAD_ATTACHMENT)
  ipcMain.removeHandler(SYNC_CHANNELS.GET_DOWNLOAD_PROGRESS)

  logger.info('Sync handlers unregistered')
}
