/**
 * Device Service
 *
 * Device-related data updates.
 */

import type { Device, DevicePlatform } from '../contracts/sync-api'

export async function getDevicesByUserId(db: D1Database, userId: string): Promise<Device[]> {
  const rows = await db
    .prepare(
      `SELECT id, user_id, name, platform, os_version, app_version, auth_public_key, created_at, last_sync_at
       FROM devices
       WHERE user_id = ? AND auth_public_key IS NOT NULL AND auth_public_key != ''`
    )
    .bind(userId)
    .all()

  return rows.results.map((row) => ({
    id: row.id as string,
    userId: row.user_id as string,
    name: row.name as string,
    platform: row.platform as DevicePlatform,
    osVersion: row.os_version as string | undefined,
    appVersion: row.app_version as string,
    authPublicKey: row.auth_public_key as string,
    linkedAt: row.created_at as number,
    lastSyncAt: row.last_sync_at as number | undefined
  }))
}

export async function updateDeviceLastSyncAt(
  db: D1Database,
  deviceId: string
): Promise<void> {
  const now = Date.now()
  await db
    .prepare(`UPDATE devices SET last_sync_at = ?, updated_at = ? WHERE id = ?`)
    .bind(now, now, deviceId)
    .run()
}
