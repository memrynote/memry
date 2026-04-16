import { ipcMain } from 'electron'
import sodium from 'libsodium-wrappers-sumo'

import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import { KEYCHAIN_ENTRIES } from '@memry/contracts/crypto'
import { SYNC_CHANNELS } from '@memry/contracts/ipc-sync'
import {
  GetHistorySchema,
  StorageBreakdownResult,
  UpdateSyncedSettingSchema
} from '@memry/contracts/ipc-sync-ops'
import { getSettingsSyncManager } from '../sync/settings-sync'
import { syncHistory } from '@memry/db-schema/schema/sync-history'

import { eq, desc, count } from 'drizzle-orm'

import type { SyncEngine } from '../sync/engine'

import { getDevicePublicKey, secureCleanup, retrieveKey } from '../crypto'
import { getDatabase, isDatabaseInitialized } from '../database/client'
import { getFromServer } from '../sync/http-client'

import { createLogger } from '../lib/logger'
import { createValidatedHandler, withErrorHandler } from './validate'
import { getSyncEngine } from '../sync/runtime'
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
import {
  clearAttachmentState,
  registerAttachmentHandlers,
  unregisterAttachmentHandlers
} from './sync-attachment-handlers'

export { seedOAuthSession } from './auth-oauth-handlers'

const logger = createLogger('IPC:Sync')

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
// Exported cleanup helper for session-teardown module
// ============================================================================

export function clearInMemoryAuthState(): void {
  clearAuthDeviceState()
  clearOAuthState()
  clearAttachmentState()
}

// ============================================================================
// Handler Registration
// ============================================================================

export function registerSyncHandlers(syncEngine?: SyncEngine): void {
  const resolveSyncEngine = (): SyncEngine | null => syncEngine ?? getSyncEngine()

  registerAuthOAuthHandlers()
  registerAuthDeviceHandlers()
  registerAttachmentHandlers()

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
  unregisterAttachmentHandlers()

  cancelTokenRefresh()

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

  logger.info('Sync handlers unregistered')
}
