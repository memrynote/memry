/**
 * Device Service
 *
 * Device-related data updates.
 */

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
