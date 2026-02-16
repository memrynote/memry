import sodium from 'libsodium-wrappers-sumo'
import { eq } from 'drizzle-orm'
import { syncDevices } from '@shared/db/schema/sync-devices'
import { DeviceKeysResponseSchema } from '@shared/contracts/sync-api'
import { createLogger } from '../lib/logger'
import { getFromServer } from './http-client'
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
    return sodium.from_base64(row.signingPublicKey, sodium.base64_variants.ORIGINAL)
  }

  await fetchAndCacheDeviceKeys(db, accessToken)

  const refreshed = db
    .select({ signingPublicKey: syncDevices.signingPublicKey })
    .from(syncDevices)
    .where(eq(syncDevices.id, deviceId))
    .get()

  if (refreshed?.signingPublicKey) {
    return sodium.from_base64(refreshed.signingPublicKey, sodium.base64_variants.ORIGINAL)
  }

  log.warn('Device not found after fetching keys from server', { deviceId })
  return null
}

export async function fetchAndCacheDeviceKeys(db: DrizzleDb, accessToken: string): Promise<void> {
  const raw = await getFromServer<unknown>('/auth/devices', accessToken)
  const parsed = DeviceKeysResponseSchema.safeParse(raw)
  if (!parsed.success) {
    log.error('Invalid device keys response from server', { error: parsed.error.message })
    return
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
}
