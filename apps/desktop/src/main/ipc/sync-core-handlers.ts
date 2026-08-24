import { ipcMain } from 'electron'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import sodium from 'libsodium-wrappers-sumo'

import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import { KEYCHAIN_ENTRIES, type KeychainEntry } from '@memry/contracts/crypto'
import { SYNC_CHANNELS } from '@memry/contracts/ipc-sync'
import { EVENT_CHANNELS, type VaultRecoveryNeededEvent } from '@memry/contracts/ipc-events'
import {
  GetHistorySchema,
  StorageBreakdownResult,
  UpdateSyncedSettingSchema
} from '@memry/contracts/ipc-sync-ops'
import { getSettingsSyncManager } from '@memry/sync-client/settings-sync'
import { listLargeNotes } from '../sync/large-notes'
import { syncHistory } from '@memry/db-schema/schema/sync-history'

import { eq, desc, count } from 'drizzle-orm'

import type { SyncEngine } from '../sync/engine'

import { getDevicePublicKey, secureCleanup, retrieveKey } from '../crypto'
import { getDatabase, isDatabaseInitialized } from '../database/client'
import { getFromServer } from '../sync/http-client'

import { createLogger } from '../lib/logger'
import { withErrorHandler } from './validate'
import { registerCommand } from './lib/register-command'
import { getSyncEngine, startSyncRuntime } from '../sync/runtime'
import { getCachedEntitlement } from '../billing/entitlement-cache'
import { teardownSession } from '../sync/session-teardown'
import { getValidAccessToken, cancelTokenRefresh } from '../sync/token-manager'
import { checkLocalKeyAgainstAccount, isKeyMaterialActivityRecent } from '../sync/key-verification'
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

// A keychain read has two very different failure modes and they must not be
// conflated: `retrieveKey` RETURNS null only when the read succeeded and the
// key is genuinely absent, but THROWS when the read itself failed transiently
// (safeStorage not yet ready, a mid-flight keytar→safeStorage migration, an
// OS keychain prompt/lock). Treating a transient throw as "key absent" makes
// the integrity check below tear down local sync state and force a re-auth
// that rebinds key material — which then no longer matches the vault, so every
// synced item fails to decrypt and fails signature verification. Only a
// confirmed null is allowed to trigger destructive cleanup.
async function readKeyForIntegrity(
  entry: KeychainEntry,
  deviceId: string
): Promise<{ transientError: true } | { transientError: false; key: Uint8Array | null }> {
  try {
    return { transientError: false, key: await retrieveKey(entry) }
  } catch (err) {
    logger.warn(
      'Skipping sync integrity check — keychain read failed transiently. ' +
        'NOT cleaning up local state (avoids a destructive re-auth on an uncertain read).',
      {
        deviceId,
        service: entry.service,
        error: err instanceof Error ? err.message : String(err)
      }
    )
    return { transientError: true }
  }
}

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

    const masterKeyRead = await readKeyForIntegrity(KEYCHAIN_ENTRIES.MASTER_KEY, currentDevice.id)
    if (masterKeyRead.transientError) return
    if (!masterKeyRead.key) {
      logger.error(
        'Detected orphaned device registration — master key missing from keychain. ' +
          'Cleaning up local state. User will need to re-authenticate.',
        { deviceId: currentDevice.id }
      )
      await cleanupLocalSyncState()
      return
    }

    const signingKeyRead = await readKeyForIntegrity(
      KEYCHAIN_ENTRIES.DEVICE_SIGNING_KEY,
      currentDevice.id
    )
    if (signingKeyRead.transientError) return
    const signingKey = signingKeyRead.key
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

    // Keys exist and are self-consistent — but do they match the ACCOUNT?
    // An install orphaned by the safeStorage regression holds a master key
    // that can never decrypt the account's data; no amount of retrying fixes
    // it. Sign the user out here at startup so the ordinary sign-in +
    // recovery-phrase flow restores the correct key, instead of leaving them
    // staring at "all items failed to decrypt".
    // 'transition' (key-material flow mid-flight) and 'unknown' (offline, no
    // verifier available) both stand down — only a CONFIRMED mismatch acts.
    const accountCheck = await checkLocalKeyAgainstAccount()
    if (accountCheck === 'mismatch' && !isKeyMaterialActivityRecent()) {
      logger.error(
        'Master key does not match the account — signing out so recovery can restore the correct key.',
        { deviceId: currentDevice.id }
      )
      emitVaultRecoveryNeededToWindows({ reason: 'vault-key-mismatch' })
      await cleanupLocalSyncState()
      return
    }
  } catch (err) {
    logger.error('Sync integrity check failed', err)
  }
}

function emitVaultRecoveryNeededToWindows(event: VaultRecoveryNeededEvent): void {
  broadcastToAllWindows(EVENT_CHANNELS.VAULT_RECOVERY_NEEDED, event)
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
    if (!engine) {
      const cached = getCachedEntitlement()
      if (cached && !cached.isPaid) {
        return { status: 'local_only', pendingCount: 0 }
      }
      return { status: 'idle', pendingCount: 0 }
    }
    return engine.getStatus()
  })

  ipcMain.handle(SYNC_CHANNELS.TRIGGER_SYNC, async () => {
    let engine: SyncEngine | null = resolveSyncEngine()
    if (!engine) {
      engine = await startSyncRuntime()
    }
    if (!engine) {
      return { success: false, error: 'errors:sync.engineNotInitialized' }
    }
    return withErrorHandler(async () => {
      // The user asked for this one, so it sweeps for remote body edits whatever
      // the automatic throttle would have said — see FullSyncRunner.run.
      await engine.fullSync({ forceCrdtSweep: true })
      return { success: true }
    }, 'errors:sync.triggerFailed')()
  })

  registerCommand(
    SYNC_CHANNELS.GET_HISTORY,
    GetHistorySchema,
    (input) => {
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
    },
    'errors:sync.historyFetchFailed'
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

  registerCommand(
    SYNC_CHANNELS.UPDATE_SYNCED_SETTING,
    UpdateSyncedSettingSchema,
    (input) => {
      const manager = getSettingsSyncManager()
      if (!manager) return { success: false, error: 'errors:sync.settingsNotInitialized' }

      manager.updateField(input.fieldPath, input.value, 'local')
      return { success: true }
    },
    'errors:sync.updateSyncedSettingFailed'
  )

  ipcMain.handle(SYNC_CHANNELS.GET_SYNCED_SETTINGS, () => {
    const manager = getSettingsSyncManager()
    if (!manager) return null
    return manager.getSettings()
  })

  ipcMain.handle(SYNC_CHANNELS.GET_STORAGE_BREAKDOWN, async () => {
    // Storage breakdown is a paid-plan endpoint: the server correctly answers
    // 402 for a free user, so calling it burns a round-trip and logs a
    // SYNC_PAYMENT_REQUIRED every time. Gate it exactly like GET_STATUS above —
    // an unknown entitlement is not gated, only a known-unpaid one.
    const cached = getCachedEntitlement()
    if (cached && !cached.isPaid) return null
    const token = await getValidAccessToken()
    if (!token) return null
    return getFromServer<StorageBreakdownResult>('/sync/storage', token)
  })

  // Purely local: reads the note cache and stats the files, so it answers with
  // no server round-trip and works for an existing vault with no reindex.
  ipcMain.handle(SYNC_CHANNELS.GET_LARGE_NOTES, () => listLargeNotes())

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
