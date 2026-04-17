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

import { deleteKey, getDevicePublicKey, storeKey } from '../crypto'
import { getDatabase } from '../database/client'
import { createLogger } from '../lib/logger'
import { deleteFromServer, postToServer } from './http-client'
import { getSyncEngine, startSyncRuntime } from './runtime'
import { startGoogleCalendarSyncRunner } from '../calendar/google/sync-service'
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
  signingSecretKey: Uint8Array
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
      challengeNonce: nonce
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
  await storeKey(KEYCHAIN_ENTRIES.DEVICE_SIGNING_KEY, signingSecretKey)

  let deviceResponse: DeviceRegisterResponse & { deviceId: string }
  try {
    const raw = await registerDevice(setupToken, signingSecretKey)
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
  } catch (keychainErr) {
    logger.error('Failed to store master key in keychain after device registration', keychainErr)

    const accessToken = await retrieveToken(KEYCHAIN_ENTRIES.ACCESS_TOKEN).catch(() => null)
    if (accessToken) {
      try {
        await deleteFromServer(`/auth/devices/${deviceResponse.deviceId}`, accessToken)
      } catch (deregErr) {
        logger.error(
          'Failed to deregister device after keychain write failure — orphaned device on server',
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

  const db = getDatabase()
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

  if (!skipActivation) {
    const engine = getSyncEngine()
    if (engine) {
      void engine.activate()
    } else {
      void startSyncRuntime()
    }
    void startGoogleCalendarSyncRunner().catch(() => {
      // Runner self-logs on failure; sign-in should succeed regardless.
    })
  }

  return deviceResponse.deviceId
}
