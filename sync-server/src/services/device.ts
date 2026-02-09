export interface Device {
  id: string
  user_id: string
  device_name: string
  device_type: string
  public_key: string
  created_at: string
  last_seen_at: string
  revoked_at: string | null
}

export const listDevices = async (db: D1Database, userId: string): Promise<Device[]> => {
  const result = await db
    .prepare('SELECT * FROM devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY last_seen_at DESC')
    .bind(userId)
    .all<Device>()
  return result.results
}

export const getDevice = async (db: D1Database, deviceId: string): Promise<Device | null> => {
  const result = await db
    .prepare('SELECT * FROM devices WHERE id = ?')
    .bind(deviceId)
    .first<Device>()
  return result
}

export const updateDevice = async (
  db: D1Database,
  deviceId: string,
  updates: Partial<Pick<Device, 'device_name' | 'last_seen_at'>>
): Promise<void> => {
  const setClauses: string[] = []
  const values: unknown[] = []

  if (updates.device_name !== undefined) {
    setClauses.push('device_name = ?')
    values.push(updates.device_name)
  }
  if (updates.last_seen_at !== undefined) {
    setClauses.push('last_seen_at = ?')
    values.push(updates.last_seen_at)
  }

  if (setClauses.length === 0) return

  values.push(deviceId)
  await db
    .prepare(`UPDATE devices SET ${setClauses.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run()
}

export const revokeDevice = async (db: D1Database, deviceId: string): Promise<void> => {
  await db
    .prepare('UPDATE devices SET revoked_at = ? WHERE id = ?')
    .bind(new Date().toISOString(), deviceId)
    .run()
}
