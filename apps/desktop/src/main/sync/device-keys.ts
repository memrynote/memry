import sodium from 'libsodium-wrappers-sumo'
import { eq } from 'drizzle-orm'
import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import { DeviceKeysResponseSchema } from '@memry/contracts/sync-api'
import { createLogger } from '../lib/logger'
import { getFromServer } from './http-client'
import { withRetry } from '@memry/sync-client/retry'
import type { DrizzleDb } from './item-handlers'

const log = createLogger('DeviceKeys')

export async function getDeviceSigningKey(
  db: DrizzleDb,
  deviceId: string,
  accessToken: string
): Promise<Uint8Array | null> {
  const row = db
    .select({ signingPublicKey: syncDevices.signingPublicKey })
    .from(syncDevices)
    .where(eq(syncDevices.id, deviceId))
    .get()

  if (row?.signingPublicKey) {
    log.debug('Device key resolved from local cache', { deviceId })
    return sodium.from_base64(row.signingPublicKey, sodium.base64_variants.ORIGINAL)
  }

  log.debug('Device key not in local cache, fetching from server', { deviceId })
  // Null below means the server's device list was read and does not name this
  // device (#2408). A list that could not be read is a failure, not an answer.
  if (!(await refreshDeviceKeys(db, accessToken))) {
    throw new Error('Invalid /auth/devices response')
  }

  const refreshed = db
    .select({ signingPublicKey: syncDevices.signingPublicKey })
    .from(syncDevices)
    .where(eq(syncDevices.id, deviceId))
    .get()

  if (refreshed?.signingPublicKey) {
    log.debug('Device key resolved after server fetch', { deviceId })
    return sodium.from_base64(refreshed.signingPublicKey, sodium.base64_variants.ORIGINAL)
  }

  log.warn('Device not found after fetching keys from server', { deviceId })
  return null
}

export async function fetchAndCacheDeviceKeys(db: DrizzleDb, accessToken: string): Promise<void> {
  await refreshDeviceKeys(db, accessToken)
}

/** Caches `GET /auth/devices`; false when the response is not a device list. */
async function refreshDeviceKeys(db: DrizzleDb, accessToken: string): Promise<boolean> {
  const { value: raw } = await withRetry(
    () => getFromServer<unknown>('/auth/devices', accessToken),
    { maxRetries: 3, baseDelayMs: 2000 }
  )
  const parsed = DeviceKeysResponseSchema.safeParse(raw)
  if (!parsed.success) {
    log.error('Invalid device keys response from server', { error: parsed.error.message })
    return false
  }

  for (const device of parsed.data.devices) {
    db.insert(syncDevices)
      .values({
        id: device.id,
        name: device.name,
        platform: device.platform,
        appVersion: 'unknown',
        linkedAt: new Date(),
        isCurrentDevice: false,
        signingPublicKey: device.signingPublicKey
      })
      .onConflictDoUpdate({
        target: syncDevices.id,
        set: { signingPublicKey: device.signingPublicKey }
      })
      .run()
  }

  log.info('Cached device keys from server', { count: parsed.data.devices.length })
  return true
}
