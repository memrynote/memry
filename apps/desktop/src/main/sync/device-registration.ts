import { app } from 'electron'
import os from 'os'
import sodium from 'libsodium-wrappers-sumo'
import { eq, inArray } from 'drizzle-orm'

import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import { syncState } from '@memry/db-schema/schema/sync-state'
import { KEYCHAIN_ENTRIES } from '@memry/contracts/crypto'
import {
  DeviceRegisterResponseSchema,
  type DeviceRegisterResponse
} from '@memry/contracts/auth-api'

import {
  bindLocalVaultToMasterKey,
  deleteKey,
  getDevicePublicKey,
  retrieveKey,
  secureCleanup,
  storeKey
} from '../crypto'
import { getStoredDeviceId, setStoredDeviceId } from '../store'
import { getDatabase } from '../database/client'
import { createLogger } from '../lib/logger'
import { deleteFromServer, postToServer } from './http-client'
import {
  clearKeyMaterialActivity,
  markKeyMaterialActivity,
  persistAccountKeyVerifier
} from './key-verification'
import { getSyncEngine, startSyncRuntime } from './runtime'
import { startGoogleCalendarSyncRunner } from '../calendar/google/sync-service'
import { getOrCreateVaultUuid } from '../agent/storage/vault-id'
import {
  ACCESS_TOKEN_EXPIRY_SECONDS,
  extractJtiFromToken,
  retrieveToken,
  scheduleTokenRefresh,
  storeToken
} from './token-manager'

const logger = createLogger('Sync:DeviceRegistration')

export const PLATFORM_MAP: Record<string, string> = {
  darwin: 'macos',
  win32: 'windows',
  linux: 'linux'
}

const registerDevice = async (
  setupToken: string,
  signingSecretKey: Uint8Array,
  vaultId: string
): Promise<DeviceRegisterResponse> => {
  await sodium.ready

  const publicKey = getDevicePublicKey(signingSecretKey)
  const publicKeyBase64 = sodium.to_base64(publicKey, sodium.base64_variants.ORIGINAL)

  const nonce = crypto.randomUUID()
  const jti = extractJtiFromToken(setupToken)
  const challengePayload = `${nonce}:${jti}`
  const payloadBytes = new TextEncoder().encode(challengePayload)
  const signature = sodium.crypto_sign_detached(payloadBytes, signingSecretKey)
  const signatureBase64 = sodium.to_base64(signature, sodium.base64_variants.ORIGINAL)

  const raw = await postToServer<unknown>(
    '/auth/devices',
    {
      name: os.hostname(),
      platform: PLATFORM_MAP[process.platform] || 'linux',
      osVersion: os.release(),
      appVersion: app.getVersion(),
      authPublicKey: publicKeyBase64,
      challengeSignature: signatureBase64,
      challengeNonce: nonce,
      vaultId
    },
    setupToken
  )
  const response = DeviceRegisterResponseSchema.parse(raw)

  if (!response.accessToken || !response.refreshToken || !response.deviceId) {
    throw new Error(response.error ?? 'Device registration failed: missing tokens')
  }

  await storeToken(KEYCHAIN_ENTRIES.ACCESS_TOKEN, response.accessToken)
  await storeToken(KEYCHAIN_ENTRIES.REFRESH_TOKEN, response.refreshToken)
  scheduleTokenRefresh(ACCESS_TOKEN_EXPIRY_SECONDS)

  return response
}

/**
 * Register the current device with the sync server, persist keys in the keychain,
 * seed the local sync_devices row, and (optionally) activate the sync engine.
 *
 * Shared between OTP first-device setup, OAuth first-device setup, and
 * recovery-phrase re-linking. Exported so `linking-service.ts` and
 * `test-hooks.ts` can drive the same code path.
 */
export const persistKeysAndRegisterDevice = async (
  masterKey: Uint8Array,
  signingSecretKey: Uint8Array,
  setupToken: string,
  kdfSalt: string,
  keyVerifier: string,
  skipSetup?: boolean,
  skipActivation?: boolean
): Promise<string> => {
  // Key material is in flux until this flow finishes — hold vault-key mismatch
  // detection off so it can't misread the transition as a broken install.
  markKeyMaterialActivity()

  await storeKey(KEYCHAIN_ENTRIES.DEVICE_SIGNING_KEY, signingSecretKey)

  const db = getDatabase()
  const vaultId = getOrCreateVaultUuid(db)

  let deviceResponse: DeviceRegisterResponse & { deviceId: string }
  try {
    const raw = await registerDevice(setupToken, signingSecretKey, vaultId)
    deviceResponse = raw as DeviceRegisterResponse & { deviceId: string }
  } catch (err) {
    await deleteKey(KEYCHAIN_ENTRIES.DEVICE_SIGNING_KEY).catch(() => {})
    throw err
  }

  if (!skipSetup) {
    const accessToken = await retrieveToken(KEYCHAIN_ENTRIES.ACCESS_TOKEN)
    if (!accessToken) {
      throw new Error('Access token not found after device registration')
    }

    try {
      await postToServer('/auth/setup', { kdfSalt, keyVerifier }, accessToken)
    } catch (err) {
      logger.error(
        'Failed to POST /auth/setup after device registration — recoverable on retry',
        err
      )
    }
  }

  try {
    await storeKey(KEYCHAIN_ENTRIES.MASTER_KEY, masterKey)
    await bindLocalVaultToMasterKey(db, vaultId, masterKey)
    // The verifier the account now lives under — the local copy lets vault-key
    // mismatch detection work offline from here on. Best-effort cache: its
    // absence only means the next check fetches from the server instead.
    try {
      persistAccountKeyVerifier(keyVerifier)
    } catch (verifierCacheErr) {
      logger.warn('Could not cache account key verifier locally', verifierCacheErr)
    }
  } catch (keyPersistenceErr) {
    logger.error('Failed to store or bind master key after device registration', keyPersistenceErr)

    const accessToken = await retrieveToken(KEYCHAIN_ENTRIES.ACCESS_TOKEN).catch(() => null)
    if (accessToken) {
      try {
        await deleteFromServer(`/auth/devices/${deviceResponse.deviceId}`, accessToken)
      } catch (deregErr) {
        logger.error(
          'Failed to deregister device after key persistence failure — orphaned device on server',
          deregErr
        )
      }
    }

    await deleteKey(KEYCHAIN_ENTRIES.ACCESS_TOKEN).catch(() => {})
    await deleteKey(KEYCHAIN_ENTRIES.REFRESH_TOKEN).catch(() => {})
    await deleteKey(KEYCHAIN_ENTRIES.DEVICE_SIGNING_KEY).catch(() => {})

    throw new Error(
      'Failed to save encryption key securely. Device registration has been rolled back. Please try again.'
    )
  }

  const pubKey = getDevicePublicKey(signingSecretKey)
  const pubKeyBase64 = sodium.to_base64(pubKey, sodium.base64_variants.ORIGINAL)

  db.transaction((tx) => {
    tx.delete(syncDevices).where(eq(syncDevices.isCurrentDevice, true)).run()
    tx.delete(syncState)
      .where(inArray(syncState.key, ['lastCursor', 'lastSyncAt', 'initialSeedDone', 'syncPaused']))
      .run()
    tx.insert(syncDevices)
      .values({
        id: deviceResponse.deviceId,
        name: os.hostname(),
        platform: PLATFORM_MAP[process.platform] || 'linux',
        osVersion: os.release(),
        appVersion: app.getVersion(),
        linkedAt: new Date(),
        isCurrentDevice: true,
        signingPublicKey: pubKeyBase64
      })
      .run()
  })

  setStoredDeviceId(deviceResponse.deviceId)

  // Flow finalized: the final master key is stored and the account verifier is
  // cached, so lift the transition hold now. Left armed, the activation below
  // (and any sync trigger for the next two minutes) classifies as 'transition'
  // and stands down — sync stays dark right after sign-in / recovery / linking.
  clearKeyMaterialActivity()

  // Stamp the registered uuid onto the current vault's store entry so the
  // account vault directory can self-register it (with its name) right away.
  try {
    const { getCurrentVaultPath, findVault, upsertVault } = await import('../store')
    const currentPath = getCurrentVaultPath()
    const storedVault = currentPath ? findVault(currentPath) : undefined
    if (storedVault) upsertVault({ ...storedVault, vaultUuid: vaultId })
  } catch (err) {
    logger.warn('Failed to stamp vault uuid after device registration', err)
  }

  if (!skipActivation) {
    const engine = getSyncEngine()
    if (engine) {
      void engine.activate()
      void import('./vault-directory')
        .then(({ refreshVaultDirectory }) => refreshVaultDirectory({ force: true }))
        .catch(() => {})
    } else {
      void startSyncRuntime()
    }
    void startGoogleCalendarSyncRunner().catch(() => {
      // Runner self-logs on failure; sign-in should succeed regardless.
    })
  }

  return deviceResponse.deviceId
}

/**
 * Seed the per-vault current-device row from the install-wide identity
 * (store deviceId + keychain signing key). Vault DBs created by dormant
 * provisioning (downloaded or linked vaults) start without a device row,
 * which makes getSigningKeys() return null and leaves the sync engine idle —
 * the vault would never pull. When a row already exists, backfill the store
 * deviceId instead so older installs become seed-capable.
 */
export const ensureDeviceRowForVault = async (
  db: ReturnType<typeof getDatabase>
): Promise<void> => {
  const existing = db
    .select({ id: syncDevices.id })
    .from(syncDevices)
    .where(eq(syncDevices.isCurrentDevice, true))
    .get()

  if (existing) {
    if (getStoredDeviceId() !== existing.id) setStoredDeviceId(existing.id)
    return
  }

  const deviceId = getStoredDeviceId()
  if (!deviceId) return

  const signingSecretKey = await retrieveKey(KEYCHAIN_ENTRIES.DEVICE_SIGNING_KEY)
  if (!signingSecretKey) return

  try {
    const pubKey = getDevicePublicKey(signingSecretKey)
    const pubKeyBase64 = sodium.to_base64(pubKey, sodium.base64_variants.ORIGINAL)
    db.insert(syncDevices)
      .values({
        id: deviceId,
        name: os.hostname(),
        platform: PLATFORM_MAP[process.platform] || 'linux',
        osVersion: os.release(),
        appVersion: app.getVersion(),
        linkedAt: new Date(),
        isCurrentDevice: true,
        signingPublicKey: pubKeyBase64
      })
      .run()
    logger.info('Seeded current device row from install identity', { deviceId })
  } finally {
    secureCleanup(signingSecretKey)
  }
}
