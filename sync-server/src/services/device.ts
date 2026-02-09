export interface Device {
  id: string
  user_id: string
  name: string
  platform: string
  os_version: string | null
  app_version: string
  auth_public_key: string
  push_token: string | null
  last_sync_at: number | null
  revoked_at: number | null
  created_at: number
  updated_at: number
}

export const listDevices = async (db: D1Database, userId: string): Promise<Device[]> => {
  const result = await db
    .prepare(
      'SELECT * FROM devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY last_sync_at DESC'
    )
    .bind(userId)
    .all<Device>()
  return result.results
}

export const getDevice = async (
  db: D1Database,
  deviceId: string,
  userId: string
): Promise<Device | null> => {
  const result = await db
    .prepare('SELECT * FROM devices WHERE id = ? AND user_id = ?')
    .bind(deviceId, userId)
    .first<Device>()
  return result
}

export const updateDevice = async (
  db: D1Database,
  deviceId: string,
  updates: Partial<Pick<Device, 'name' | 'last_sync_at'>>
): Promise<void> => {
  const setClauses: string[] = []
  const values: unknown[] = []

  if (updates.name !== undefined) {
    setClauses.push('name = ?')
    values.push(updates.name)
  }
  if (updates.last_sync_at !== undefined) {
    setClauses.push('last_sync_at = ?')
    values.push(updates.last_sync_at)
  }

  if (setClauses.length === 0) return

  setClauses.push('updated_at = ?')
  values.push(Math.floor(Date.now() / 1000))
  values.push(deviceId)

  await db
    .prepare(`UPDATE devices SET ${setClauses.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run()
}

export const revokeDevice = async (db: D1Database, deviceId: string): Promise<void> => {
  await db
    .prepare('UPDATE devices SET revoked_at = ? WHERE id = ?')
    .bind(Math.floor(Date.now() / 1000), deviceId)
    .run()
}
